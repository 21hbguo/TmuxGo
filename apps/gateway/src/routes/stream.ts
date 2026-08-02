import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { agentManager } from '../agent-manager.js'
import { assertSessionAllowed, prepareSessionAttach } from '../lib/tmux-policy.js'
import { recordStreamMetric, updateStreamMetric } from '../lib/perf-metrics.js'
import { getHostById, getHostCredentials } from '../lib/hosts.js'
import { buildHostSshOptions, resolveHostPassword } from '../lib/ssh-options.js'
import { createTerminalOutputSanitizer, hasSubstantiveTerminalContent } from '../lib/terminal-output.js'
import { parseSessionRef } from '../lib/tmux-target.js'
import { getAttachSnapshotDelays } from '../lib/attach-snapshot.js'
import { execTmux } from '../lib/tmux-executor.js'
import { getHostAgentPanes, markAgentPaneSeen } from '../lib/agent-state.js'
import { streamAttachMessageSchema, streamInputMessageSchema, streamMessageSchema, streamRegisterMessageSchema, streamResizeMessageSchema } from '../lib/request-validation.js'
import { encodeStreamCellBinary, encodeStreamOutputBinary } from '../lib/stream-binary.js'
import { AnsiParser, TerminalGrid, diffCells, encodeCellDiff, encodeCellSnapshot } from '../lib/terminal-grid/index.js'
import { consumeWebSocketTicket, isAuthEnabled } from '../lib/auth.js'

const execFileAsync = promisify(execFile)
let sshPassAvailable: boolean | null = null
export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/stream', { websocket: true }, (connection: SocketStream, request: FastifyRequest) => {
    if (isAuthEnabled()) {
      const query = request.query as { ticket?: unknown }
      const ticket = typeof query.ticket === 'string' ? query.ticket : ''
      if (!consumeWebSocketTicket(ticket)) {
        connection.socket.close(1008, 'Authentication required')
        return
      }
    }
    console.log('Client connected to stream')
    const SCROLL_MAX_LINES = 24
    const ATTACH_REDRAW_DELAYS = [48]
    const REQUEST_REDRAW_DELAYS = [48]
    const AGENT_STATE_POLL_MS = 1500
    const SOCKET_BUFFER_HIGH_WATERMARK = 1048576
    const SOCKET_BUFFER_EXTREME_WATERMARK = 4194304
    const SOCKET_FLUSH_DEFER_MS = 24
    const OUTPUT_BUFFER_MAX_CHARS = 1048576
    const CLIENT_BACKPRESSURE_RESYNC_CHARS = 16384
    const STREAM_COMPRESS_ENABLED = process.env.TMUXGO_STREAM_COMPRESS !== '0'
    const STREAM_COMPRESS_THRESHOLD = Math.max(0, Number(process.env.TMUXGO_STREAM_COMPRESS_THRESHOLD || 256) || 256)
    const STREAM_CELL_ENABLED = process.env.TMUXGO_STREAM_CELL === '1'
    const CELL_DIRTY_RATIO_SNAPSHOT = 0.55
    const DEDUP_CHUNK_THRESHOLD = Math.max(0, Number(process.env.TMUXGO_DEDUP_CHUNK_THRESHOLD || 512) || 512)
    const DEDUP_WINDOW_SIZE = Math.max(1, Number(process.env.TMUXGO_DEDUP_WINDOW || 32) || 32)
    const FOREGROUND_FLUSH_INTERVAL = Math.max(1, Number(process.env.TMUXGO_FLUSH_INTERVAL || 4) || 4)
    const OUTPUT_PROFILES = {
      foreground: { flushInterval: FOREGROUND_FLUSH_INTERVAL, maxChars: 65536 },
      background: { flushInterval: 32, maxChars: 24576 },
      mobile: { flushInterval: 24, maxChars: 16384 },
    } as const
    let ptyProcess: pty.IPty | null = null
    let attachedSessionName: string | null = null
    let attachedHostId = 'local'
    let attachedExclusive = false
    let attachedCols = 0
    let attachedRows = 0
    let agentId: string | null = null
    let outputBuffer = ''
    let lastFrame = ''
    let dedupDropLogCount = 0
    let outputTimer: ReturnType<typeof setTimeout> | null = null
    let deferredFlushTimer: ReturnType<typeof setTimeout> | null = null
    let outputResyncPending = false
    let outputResyncRunning = false
    let redrawTimers: ReturnType<typeof setTimeout>[] = []
    let outputProfile: keyof typeof OUTPUT_PROFILES = 'foreground'
    let clientBackpressureHigh = false
    let binaryOutputEnabled = false
    let compressOutputEnabled = false
    let cellOutputEnabled = false
    let cellModeActive = false
    let cellGrid: TerminalGrid | null = null
    let cellParser: AnsiParser | null = null
    let cellBaseSeq = 0
    let cellLastCursorX = -1
    let cellLastCursorY = -1
    let cellLastFlags = -1
    let attachSeq = 0
    let attachVisibleOutputObserved = false
    let attachSnapshotTimers: ReturnType<typeof setTimeout>[] = []
    let agentStatePolling = false
    let pendingResizeAck: { sessionName: string; hostId: string; cols: number; rows: number; seq: number; refreshComplete: boolean; outputObserved: boolean } | null = null
    const sentAgentRevisions = new Map<string, number>()
    const scrollBuffers = new Map<string, number>()
    const scrollRunning = new Set<string>()
    const socket = connection.socket
    let sanitizeTerminalOutput = createTerminalOutputSanitizer()
    function sanitizeOutput(chunk: string) {
      recordStreamMetric('sanitizeCalls')
      recordStreamMetric('sanitizeChars', chunk.length)
      return sanitizeTerminalOutput(chunk)
    }
    updateStreamMetric('activeClients', streamPerfMetricsActiveClientsDelta(1))
    syncOutputProfile(outputProfile)
    function streamPerfMetricsActiveClientsDelta(delta: number) {
      const next = Math.max(0, Number((globalThis as any).__tmuxgoActiveClients || 0) + delta)
      ;(globalThis as any).__tmuxgoActiveClients = next
      return next
    }
    function syncOutputProfile(profile: keyof typeof OUTPUT_PROFILES) {
      const changed = outputProfile !== profile
      outputProfile = profile
      const current = OUTPUT_PROFILES[profile]
      updateStreamMetric('activeProfile', profile)
      updateStreamMetric('activeFlushInterval', current.flushInterval)
      updateStreamMetric('activeMaxChars', current.maxChars)
      if (changed) recordStreamMetric('profileUpdates')
    }
    function requestLatestFrameResync() {
      if (outputResyncPending) {
        if (outputBuffer) {
          recordStreamMetric('droppedOutputChars', outputBuffer.length)
          outputBuffer = ''
        }
        return
      }
      if (outputBuffer) recordStreamMetric('droppedOutputChars', outputBuffer.length)
      recordStreamMetric('outputResyncRequests')
      outputBuffer = ''
      lastFrame = ''
      sanitizeTerminalOutput = createTerminalOutputSanitizer()
      outputResyncPending = true
      if (outputTimer) {
        clearTimeout(outputTimer)
        outputTimer = null
      }
      scheduleDeferredFlush()
    }
    function getOutputProfileConfig() {
      return OUTPUT_PROFILES[outputProfile]
    }
    function getSocketBufferedBytes() {
      const buffered = Math.max(0, Number(socket.bufferedAmount) || 0)
      updateStreamMetric('socketBufferedBytes', buffered)
      if (buffered >= SOCKET_BUFFER_EXTREME_WATERMARK && outputProfile === 'foreground') syncOutputProfile('background')
      return buffered
    }
    function send(data: any) {
      if (socket.readyState !== 1) return false
      try {
        getSocketBufferedBytes()
        socket.send(JSON.stringify(data))
        getSocketBufferedBytes()
        return true
      } catch {
        return false
      }
    }
    function resetCellState(cols = attachedCols || 80, rows = attachedRows || 24) {
      cellGrid = new TerminalGrid(Math.max(1, cols || 80), Math.max(1, rows || 24))
      cellParser = new AnsiParser(cellGrid)
      cellBaseSeq = 0
      cellLastCursorX = -1
      cellLastCursorY = -1
      cellLastFlags = -1
      cellModeActive = cellOutputEnabled && binaryOutputEnabled
    }
    function disableCellMode(reason?: string) {
      if (cellModeActive) recordStreamMetric('cellFallbackAnsi')
      cellModeActive = false
      cellParser?.resetParserState()
    }
    function sendTerminalOutput(type: 'output' | 'output_resync', data: string, sessionName: string, hostId: string) {
      if (socket.readyState !== 1) return false
      try {
        getSocketBufferedBytes()
        if (binaryOutputEnabled) {
          const rawLen = Buffer.byteLength(data || '', 'utf8')
          const frame = encodeStreamOutputBinary(type, hostId, sessionName, data, {
            compress: compressOutputEnabled,
            threshold: STREAM_COMPRESS_THRESHOLD,
          })
          const typeCode = frame[3]
          if (typeCode === 3 || typeCode === 4) {
            recordStreamMetric('compressFrames')
            recordStreamMetric('compressBytesIn', rawLen)
            recordStreamMetric('compressBytesOut', frame.length - 12)
          }
          socket.send(frame)
          recordStreamMetric('outputBytes', frame.length)
        } else {
          socket.send(JSON.stringify({ type, data, sessionName, hostId }))
          recordStreamMetric('outputBytes', Buffer.byteLength(data || '', 'utf8'))
        }
        getSocketBufferedBytes()
        return true
      } catch {
        return false
      }
    }
    function sendCellFrame(type: 'cell_snapshot' | 'cell_diff', payload: Buffer, sessionName: string, hostId: string) {
      if (socket.readyState !== 1 || !binaryOutputEnabled || !cellOutputEnabled) return false
      try {
        getSocketBufferedBytes()
        const useGzip = compressOutputEnabled && type === 'cell_snapshot'
        const frame = encodeStreamCellBinary(type, hostId, sessionName, payload, {
          compress: useGzip,
          threshold: STREAM_COMPRESS_THRESHOLD,
        })
        const typeCode = frame[3]
        if (typeCode === 6 || typeCode === 8) {
          recordStreamMetric('compressFrames')
          recordStreamMetric('compressBytesIn', payload.length)
          recordStreamMetric('compressBytesOut', frame.length - 12)
        }
        socket.send(frame)
        recordStreamMetric('outputBytes', frame.length)
        getSocketBufferedBytes()
        return true
      } catch {
        return false
      }
    }
    function feedCellAndMaybeSend(kind: 'output' | 'output_resync', data: string, sessionName: string, hostId: string) {
      if (!cellModeActive || !cellGrid || !cellParser) return false
      if (kind === 'output_resync') {
        cellGrid.resize(attachedCols || cellGrid.cols, attachedRows || cellGrid.rows)
        cellGrid.clear()
        cellParser.resetParserState()
        cellBaseSeq = 0
      }
      const prev = cellGrid.cloneCells()
      const parsed = cellParser.feed(data)
      if (!parsed.ok) {
        recordStreamMetric('cellFallbackAnsi')
        return false
      }
      const changes = kind === 'output_resync' ? [] : diffCells(prev, cellGrid.cells, cellGrid.cols, cellGrid.rows)
      const total = Math.max(1, cellGrid.cols * cellGrid.rows)
      const dirtyRatio = kind === 'output_resync' ? 1 : changes.length / total
      const cursorChanged = cellGrid.cursorX !== cellLastCursorX || cellGrid.cursorY !== cellLastCursorY || cellGrid.flags !== cellLastFlags
      if (kind !== 'output_resync' && cellBaseSeq > 0 && changes.length === 0 && !cursorChanged) {
        return true
      }
      cellGrid.seq += 1
      recordStreamMetric('cellDirtyCells', kind === 'output_resync' ? total : changes.length)
      let ok = false
      if (kind === 'output_resync' || dirtyRatio >= CELL_DIRTY_RATIO_SNAPSHOT || cellBaseSeq === 0) {
        const payload = encodeCellSnapshot(cellGrid)
        ok = sendCellFrame('cell_snapshot', payload, sessionName, hostId)
        if (ok) recordStreamMetric('cellSnapshots')
      } else {
        const payload = encodeCellDiff(cellGrid.seq, cellBaseSeq, cellGrid.cursorX, cellGrid.cursorY, cellGrid.flags, changes)
        ok = sendCellFrame('cell_diff', payload, sessionName, hostId)
        if (ok) recordStreamMetric('cellDiffs')
      }
      if (!ok) return false
      cellBaseSeq = cellGrid.seq
      cellLastCursorX = cellGrid.cursorX
      cellLastCursorY = cellGrid.cursorY
      cellLastFlags = cellGrid.flags
      return true
    }
    function scheduleDeferredFlush() {
      if (deferredFlushTimer) return
      recordStreamMetric('deferredFlushes')
      deferredFlushTimer = setTimeout(() => {
        deferredFlushTimer = null
        flushOutput()
      }, SOCKET_FLUSH_DEFER_MS)
    }
    async function flushOutputResync() {
      if (!outputResyncPending || outputResyncRunning || !ptyProcess || !attachedSessionName) return
      const sessionName = attachedSessionName
      const hostId = attachedHostId
      const seq = attachSeq
      outputResyncRunning = true
      try {
        const { stdout } = await execTmux(hostId, ['capture-pane', '-e', '-pt', sessionName, '-p'])
        if (!outputResyncPending || !ptyProcess || seq !== attachSeq || attachedSessionName !== sessionName || attachedHostId !== hostId) return
        if (getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) {
          scheduleDeferredFlush()
          return
        }
        const data = `\u001b[H\u001b[2J${String(stdout || '')}`
        let sent = false
        if (cellModeActive) sent = feedCellAndMaybeSend('output_resync', data, sessionName, hostId)
        if (!sent) {
          if (!sendTerminalOutput('output_resync', data, sessionName, hostId)) {
            scheduleDeferredFlush()
            return
          }
        }
        outputResyncPending = false
        recordStreamMetric('outputResyncCompleted')
        recordStreamMetric('outputFlushes')
        recordStreamMetric('outputChunks')
      } catch {
        scheduleDeferredFlush()
      } finally {
        outputResyncRunning = false
        if (outputResyncPending) scheduleDeferredFlush()
        else if (outputBuffer) flushOutput()
      }
    }
    function flushOutput() {
      if (!attachedSessionName) return
      if (outputResyncPending) {
        if (getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) scheduleDeferredFlush()
        else void flushOutputResync()
        return
      }
      if (!outputBuffer) return
      if (getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) {
        scheduleDeferredFlush()
        return
      }
      const data = outputBuffer
      outputBuffer = ''
      const isCompleteFrame = data.startsWith('\u001b[?25l') && data.endsWith('\u001b[?25h')
      if (isCompleteFrame && data.length >= DEDUP_CHUNK_THRESHOLD && data === lastFrame) {
        recordStreamMetric('droppedDuplicateChunks', data.length)
        if (dedupDropLogCount < 30) {
          dedupDropLogCount++
          console.warn(`[frame-dedup#${dedupDropLogCount}] len=${data.length}`)
        }
        return
      }
      let sent = false
      if (cellModeActive) sent = feedCellAndMaybeSend('output', data, attachedSessionName, attachedHostId)
      if (!sent) {
        if (!sendTerminalOutput('output', data, attachedSessionName, attachedHostId)) {
          outputBuffer = data + outputBuffer
          return
        }
      }
      if (isCompleteFrame) {
        lastFrame = data
      } else if (data.startsWith('\u001b[?25l') && dedupDropLogCount < 30) {
        dedupDropLogCount++
        console.warn(`[frame-incomplete#${dedupDropLogCount}] len=${data.length} tail=${JSON.stringify(data.slice(-40))}`)
      }
      recordStreamMetric('outputFlushes')
      recordStreamMetric('outputChunks')
    }
    function completeResizeAck() {
      const pending = pendingResizeAck
      if (!pending || !pending.refreshComplete || !pending.outputObserved) return
      if (!ptyProcess || pending.seq !== attachSeq || attachedSessionName !== pending.sessionName || attachedHostId !== pending.hostId || attachedCols !== pending.cols || attachedRows !== pending.rows) return
      pendingResizeAck = null
      flushOutput()
      send({ type: 'resized', sessionName: pending.sessionName, hostId: pending.hostId, cols: pending.cols, rows: pending.rows })
    }
    function queueOutput(output: string) {
      if (!output) return
      if (outputResyncPending) {
        recordStreamMetric('droppedOutputChars', output.length)
        return
      }
      outputBuffer += output
      const congestedLimit = clientBackpressureHigh ? CLIENT_BACKPRESSURE_RESYNC_CHARS : OUTPUT_BUFFER_MAX_CHARS
      if (outputBuffer.length > congestedLimit) {
        requestLatestFrameResync()
        return
      }
      const profile = getOutputProfileConfig()
      if (outputBuffer.length >= profile.maxChars) {
        if (outputTimer) {
          clearTimeout(outputTimer)
          outputTimer = null
        }
        flushOutput()
        return
      }
      if (outputTimer) return
      const flushDelay = profile.flushInterval
      if (flushDelay <= 0 || (outputProfile === 'foreground' && !clientBackpressureHigh && getSocketBufferedBytes() < SOCKET_BUFFER_HIGH_WATERMARK / 8 && outputBuffer.length >= STREAM_COMPRESS_THRESHOLD && !cellModeActive)) {
        flushOutput()
        return
      }
      outputTimer = setTimeout(() => {
        outputTimer = null
        flushOutput()
      }, flushDelay)
    }
    async function hasSshPass() {
      if (sshPassAvailable !== null) return sshPassAvailable
      try {
        await execFileAsync('sshpass', ['-V'])
        sshPassAvailable = true
      } catch {
        sshPassAvailable = false
      }
      return sshPassAvailable
    }
    async function runTmuxOnHost(hostId: string, args: string[]) {
      await execTmux(hostId, args)
    }
    async function applyScroll(hostId: string, sessionName: string, lines: number) {
      if (!lines) return
      const action = lines > 0 ? 'scroll-up' : 'scroll-down'
      let remaining = Math.abs(lines)
      if (lines > 0) {
        const step = Math.min(remaining, SCROLL_MAX_LINES)
        await runTmuxOnHost(hostId, ['copy-mode', '-e', '-t', sessionName, ';', 'send-keys', '-t', sessionName, '-X', '-N', String(step), action])
        remaining -= step
      }
      while (remaining > 0) {
        const step = Math.min(remaining, SCROLL_MAX_LINES)
        await runTmuxOnHost(hostId, ['send-keys', '-t', sessionName, '-X', '-N', String(step), action])
        remaining -= step
      }
    }
    function flushScroll(sessionName: string) {
      if (scrollRunning.has(sessionName)) return
      const lines = scrollBuffers.get(sessionName) || 0
      scrollBuffers.delete(sessionName)
      if (!lines) return
      const hostId = attachedHostId
      scrollRunning.add(sessionName)
      void applyScroll(hostId, sessionName, lines).catch(() => {}).finally(() => {
        scrollRunning.delete(sessionName)
        if (scrollBuffers.has(sessionName)) flushScroll(sessionName)
      })
    }
    function queueScroll(sessionName: string, lines: number) {
      if (!sessionName || !lines) return
      const next = (scrollBuffers.get(sessionName) || 0) + lines
      scrollBuffers.set(sessionName, Math.max(-SCROLL_MAX_LINES * 4, Math.min(SCROLL_MAX_LINES * 4, next)))
      if (scrollRunning.has(sessionName)) return
      flushScroll(sessionName)
    }
    function clearRedrawTimers() {
      for (const timer of redrawTimers) clearTimeout(timer)
      redrawTimers = []
    }
    function clearAttachSnapshotTimers() {
      for (const timer of attachSnapshotTimers) clearTimeout(timer)
      attachSnapshotTimers = []
    }
    async function pollAgentStates() {
      if (agentStatePolling || !attachedSessionName) return
      const hostId = attachedHostId
      agentStatePolling = true
      try {
        const panes = await getHostAgentPanes(hostId)
        if (hostId !== attachedHostId) return
        for (const pane of panes) {
          const previousRevision = sentAgentRevisions.get(pane.paneId)
          if (previousRevision !== undefined && pane.revision <= previousRevision) continue
          sentAgentRevisions.set(pane.paneId, pane.revision)
          send({ type: 'agent_status_changed', hostId, sessionName: pane.sessionName, pane, initial: previousRevision === undefined })
        }
      } catch {} finally {
        agentStatePolling = false
      }
    }
    const agentStateTimer = setInterval(() => void pollAgentStates(), AGENT_STATE_POLL_MS)
    async function captureAttachedSnapshot(sessionName: string, seq: number) {
      if (!ptyProcess || !sessionName || attachVisibleOutputObserved || seq !== attachSeq || attachedSessionName !== sessionName) return
      try {
        const { stdout } = await execTmux(attachedHostId, ['capture-pane', '-e', '-pt', sessionName, '-p'])
        if (!ptyProcess || !sessionName || attachVisibleOutputObserved || seq !== attachSeq || attachedSessionName !== sessionName) return
        const snapshot = String(stdout || '')
        if (!snapshot) return
        const data = `\u001b[H\u001b[2J${snapshot}`
        let sent = false
        if (cellModeActive) sent = feedCellAndMaybeSend('output_resync', data, sessionName, attachedHostId)
        if (!sent && !sendTerminalOutput('output_resync', data, sessionName, attachedHostId)) return
        attachVisibleOutputObserved = true
        recordStreamMetric('outputResyncCompleted')
        recordStreamMetric('outputFlushes')
        recordStreamMetric('outputChunks')
        recordStreamMetric('outputBytes', data.length)
      } catch {}
    }
    function scheduleAttachSnapshot(sessionName: string, seq: number, delays = getAttachSnapshotDelays()) {
      if (!sessionName) return
      clearAttachSnapshotTimers()
      for (const delay of delays) {
        const timer = setTimeout(() => {
          attachSnapshotTimers = attachSnapshotTimers.filter((item) => item !== timer)
          if (attachVisibleOutputObserved || seq !== attachSeq || attachedSessionName !== sessionName) return
          void captureAttachedSnapshot(sessionName, seq)
        }, delay)
        attachSnapshotTimers.push(timer)
      }
    }
    async function refreshAttachedClient(sessionName: string) {
      if (!ptyProcess || !sessionName) return
      const pid = String(ptyProcess.pid)
      const { stdout } = await execTmux(attachedHostId, ['list-clients', '-t', sessionName, '-F', '#{client_pid}|#{client_name}'])
      const clients = String(stdout).trim().split('\n').filter(Boolean).map((line) => {
        const [clientPid, ...nameParts] = line.split('|')
        return { pid: clientPid, name: nameParts.join('|') }
      }).filter((client) => client.name)
      const owned = clients.filter((client) => client.pid === pid)
      const targets = (owned.length ? owned : clients).map((client) => client.name)
      for (const target of targets) {
        await execTmux(attachedHostId, ['refresh-client', '-t', target])
      }
    }
    function scheduleClientRedraw(sessionName: string | null = attachedSessionName, delays = [48]) {
      if (!sessionName) return
      clearRedrawTimers()
      const seq = attachSeq
      for (const delay of delays) {
        const timer = setTimeout(() => {
          redrawTimers = redrawTimers.filter((item) => item !== timer)
          if (seq !== attachSeq || attachedSessionName !== sessionName) return
          void refreshAttachedClient(sessionName).catch(() => {})
        }, delay)
        redrawTimers.push(timer)
      }
    }
    function cleanup(notify = false) {
      const current = ptyProcess
      const detachedSessionName = attachedSessionName
      const detachedHostId = attachedHostId
      attachSeq += 1
      pendingResizeAck = null
      clearRedrawTimers()
      clearAttachSnapshotTimers()
      if (current) {
        current.kill()
        ptyProcess = null
      }
      attachVisibleOutputObserved = false
      attachedSessionName = null
      attachedHostId = 'local'
      attachedExclusive = false
      attachedCols = 0
      attachedRows = 0
      if (outputTimer) {
        clearTimeout(outputTimer)
        outputTimer = null
      }
      if (deferredFlushTimer) {
        clearTimeout(deferredFlushTimer)
        deferredFlushTimer = null
      }
      outputBuffer = ''
      sanitizeTerminalOutput = createTerminalOutputSanitizer()
      outputResyncPending = false
      outputResyncRunning = false
      clientBackpressureHigh = false
      scrollBuffers.clear()
      sentAgentRevisions.clear()
      if (notify) send({ type: 'detached', sessionName: detachedSessionName, hostId: detachedHostId })
    }
    async function getSessionWindowSize(sessionName: string, hostId: string) {
      try {
        const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', sessionName, '#{window_width}|#{window_height}'])
        const [colsText, rowsText] = stdout.trim().split('|')
        const cols = parseInt(colsText, 10)
        const rows = parseInt(rowsText, 10)
        if (cols > 0 && rows > 0) return { cols, rows }
      } catch {}
      return null
    }
    async function resolveAttachTarget(data: any) {
      const hostId = typeof data.hostId === 'string' && data.hostId.trim() ? data.hostId.trim() : 'local'
      const sessionNameRaw = String(data.sessionName || '').trim()
      if (!sessionNameRaw) throw new Error('Missing session name')
      if (sessionNameRaw.startsWith('session-')) {
        const parsed = parseSessionRef(hostId, sessionNameRaw)
        return { hostId: parsed.hostId, sessionName: parsed.sessionName }
      }
      if (hostId !== 'local') {
        const parsed = parseSessionRef(hostId, sessionNameRaw)
        return { hostId: parsed.hostId, sessionName: parsed.sessionName }
      }
      assertSessionAllowed(sessionNameRaw)
      return { hostId, sessionName: sessionNameRaw }
    }
    socket.on('message', async (message: Buffer) => {
      try {
        const data: any = streamMessageSchema.parse(JSON.parse(message.toString()))
        switch (data.type) {
          case 'register': {
            const register = streamRegisterMessageSchema.parse(data)
            agentId = register.host.id
            agentManager.register(register.host.id, register.host.name, register.host.address, socket)
            send({ type: 'registered', agentId: register.host.id })
            break
          }
          case 'attach': {
            const attach = streamAttachMessageSchema.parse(data)
            recordStreamMetric('attachRequests')
            console.log('Attach requested', { hostId: attach.hostId, sessionName: attach.sessionName, exclusive: !!attach.exclusive, cols: attach.cols, rows: attach.rows })
            const { hostId, sessionName } = await resolveAttachTarget(attach)
            if (hostId === 'local') await prepareSessionAttach(sessionName)
            const requestedCols = attach.cols || 80
            const requestedRows = attach.rows || 24
            const exclusive = !!attach.exclusive
            if (ptyProcess && attachedSessionName === sessionName && attachedExclusive === exclusive && attachedHostId === hostId) {
              attachVisibleOutputObserved = false
              if (exclusive && requestedCols > 0 && requestedRows > 0 && (requestedCols !== attachedCols || requestedRows !== attachedRows)) {
                ptyProcess.resize(requestedCols, requestedRows)
                attachedCols = requestedCols
                attachedRows = requestedRows
              }
              send({ type: 'attached', sessionName, hostId, cols: attachedCols || requestedCols, rows: attachedRows || requestedRows, exclusive })
              scheduleClientRedraw(sessionName, ATTACH_REDRAW_DELAYS)
              scheduleAttachSnapshot(sessionName, attachSeq)
              break
            }
            cleanup()
            const sharedSize = exclusive ? null : await getSessionWindowSize(sessionName, hostId)
            const cols = sharedSize?.cols || requestedCols
            const rows = sharedSize?.rows || requestedRows
            if (hostId !== 'local') {
              const host = await getHostById(hostId)
              if (!host) throw new Error('Host not found')
              const credentials = await getHostCredentials(host.id)
              const target = `${host.user}@${host.address}`
              const sshBaseArgs = ['-p', String(host.port), '-tt', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', ...buildHostSshOptions(host, credentials), target, '--', 'tmux', 'attach']
              if (!exclusive) sshBaseArgs.push('-f', 'ignore-size,active-pane')
              sshBaseArgs.push('-t', sessionName)
              const hostPassword = resolveHostPassword(credentials)
              if (hostPassword) {
                if (!await hasSshPass()) throw new Error('sshpass is required for password auth')
                ptyProcess = pty.spawn('sshpass', ['-e', 'ssh', '-o', 'BatchMode=no', ...sshBaseArgs], {
                  name: 'xterm-256color',
                  cols,
                  rows,
                  env: { ...process.env, SSHPASS: hostPassword, TERM: 'xterm-256color' },
                })
              } else {
                ptyProcess = pty.spawn('ssh', ['-o', 'BatchMode=yes', ...sshBaseArgs], {
                  name: 'xterm-256color',
                  cols,
                  rows,
                  env: { ...process.env, TERM: 'xterm-256color' },
                })
              }
            } else {
              const attachArgs = ['attach']
              if (!exclusive) {
                attachArgs.push('-f', 'ignore-size,active-pane')
              }
              attachArgs.push('-t', sessionName)
              ptyProcess = pty.spawn('tmux', attachArgs, {
                name: 'xterm-256color',
                cols,
                rows,
                env: { ...process.env, TERM: 'xterm-256color' },
              })
            }
            attachedSessionName = sessionName
            attachedHostId = hostId
            attachedExclusive = exclusive
            attachedCols = cols
            attachedRows = rows
            if (cellOutputEnabled) resetCellState(cols, rows)
            attachVisibleOutputObserved = false
            lastFrame = ''
            dedupDropLogCount = 0
            const seq = attachSeq
            ptyProcess.onData((output: string) => {
              if (seq !== attachSeq) return
              if (outputResyncPending) {
                recordStreamMetric('droppedOutputChars', output.length)
                if (pendingResizeAck) {
                  pendingResizeAck.outputObserved = true
                  completeResizeAck()
                }
                return
              }
              const filtered = sanitizeOutput(output)
              if (filtered) {
                if (!attachVisibleOutputObserved && hasSubstantiveTerminalContent(filtered)) attachVisibleOutputObserved = true
                queueOutput(filtered)
              }
              if (pendingResizeAck) {
                pendingResizeAck.outputObserved = true
                completeResizeAck()
              }
            })
            ptyProcess.onExit(({ exitCode }) => {
              if (seq !== attachSeq) return
              const exitedSessionName = attachedSessionName
              const exitedHostId = attachedHostId
              const exitedExclusive = attachedExclusive
              flushOutput()
              send({ type: 'session-exit', exitCode, hostId: exitedHostId, sessionName: exitedSessionName, exclusive: exitedExclusive })
              send({ type: 'detached', hostId: exitedHostId, sessionName: exitedSessionName, exitCode })
              ptyProcess = null
              attachedSessionName = null
              attachedHostId = 'local'
              attachedExclusive = false
              attachedCols = 0
              attachedRows = 0
              pendingResizeAck = null
              clearAttachSnapshotTimers()
              clearRedrawTimers()
            })
            send({ type: 'attached', sessionName, hostId, cols, rows, exclusive })
            void pollAgentStates()
            scheduleClientRedraw(sessionName, ATTACH_REDRAW_DELAYS)
            scheduleAttachSnapshot(sessionName, seq)
            break
          }
          case 'resize': {
            const resize = streamResizeMessageSchema.parse(data)
            recordStreamMetric('resizeRequests')
            if (ptyProcess) {
              const cols = Math.max(2, Math.round(resize.cols))
              const rows = Math.max(1, Math.round(resize.rows))
              if (!Number.isFinite(cols) || !Number.isFinite(rows) || !attachedSessionName) break
              if (cols === attachedCols && rows === attachedRows) {
                send({ type: 'resized', sessionName: attachedSessionName, hostId: attachedHostId, cols, rows })
                break
              }
              const pending = { sessionName: attachedSessionName, hostId: attachedHostId, cols, rows, seq: attachSeq, refreshComplete: false, outputObserved: false }
              pendingResizeAck = pending
              ptyProcess.resize(cols, rows)
              attachedCols = cols
              attachedRows = rows
              if (cellOutputEnabled) resetCellState(cols, rows)
              void refreshAttachedClient(pending.sessionName).catch(() => {}).finally(() => {
                if (pendingResizeAck !== pending) return
                pending.refreshComplete = true
                completeResizeAck()
              })
            }
            break
          }
          case 'redraw': {
            recordStreamMetric('redrawRequests')
            const sessionName = data.sessionName
            if (!sessionName) break
            assertSessionAllowed(sessionName)
            if (sessionName === attachedSessionName && data.hostId === attachedHostId) scheduleClientRedraw(sessionName, REQUEST_REDRAW_DELAYS)
            break
          }
          case 'input': {
            const input = streamInputMessageSchema.parse(data)
            recordStreamMetric('inputMessages')
            if (ptyProcess) ptyProcess.write(input.data)
            break
          }
          case 'agent_seen': {
            const paneId = String(data.paneId || '')
            if (!paneId.startsWith(`${attachedHostId}:`)) break
            const pane = markAgentPaneSeen(paneId)
            if (pane) {
              sentAgentRevisions.set(pane.paneId, pane.revision)
              send({ type: 'agent_status_changed', hostId: attachedHostId, sessionName: attachedSessionName, pane, initial: false })
            }
            break
          }
          case 'stream_caps':
            binaryOutputEnabled = data.binaryOutput === true
            compressOutputEnabled = STREAM_COMPRESS_ENABLED && binaryOutputEnabled && data.compressOutput === 'gzip'
            cellOutputEnabled = STREAM_CELL_ENABLED && binaryOutputEnabled && data.cellOutput === true
            if (cellOutputEnabled) resetCellState(attachedCols || 80, attachedRows || 24)
            else {
              cellModeActive = false
              cellGrid = null
              cellParser = null
            }
            send({
              type: 'stream_caps',
              binaryOutput: binaryOutputEnabled,
              compressOutput: compressOutputEnabled ? 'gzip' : false,
              cellOutput: cellOutputEnabled,
            })
            break
          case 'cell_resync_request':
            if (cellOutputEnabled && attachedSessionName) {
              resetCellState(attachedCols || 80, attachedRows || 24)
              requestLatestFrameResync()
            }
            break
          case 'stream_profile':
            if (data.profile === 'foreground' || data.profile === 'background' || data.profile === 'mobile') syncOutputProfile(data.profile)
            break
          case 'stream_backpressure':
            recordStreamMetric('backpressureSignals')
            if (data.level === 'high') {
              clientBackpressureHigh = true
              syncOutputProfile(data.mobile ? 'mobile' : 'background')
              if (outputBuffer.length >= CLIENT_BACKPRESSURE_RESYNC_CHARS || getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) {
                requestLatestFrameResync()
              }
            } else if (data.level === 'normal') {
              clientBackpressureHigh = false
              syncOutputProfile(data.mobile ? 'mobile' : 'foreground')
            }
            break
          case 'pane_scroll': {
            const scrollLines = Number(data.lines) || 0
            if (scrollLines === 0) break
            const sessionName = data.sessionName
            if (!sessionName) break
            assertSessionAllowed(sessionName)
            if (data.hostId !== attachedHostId) break
            recordStreamMetric('paneScrollRequests')
            queueScroll(sessionName, scrollLines)
            break
          }
          case 'copy_mode_cancel': {
            const sessionName = data.sessionName
            if (!sessionName) break
            assertSessionAllowed(sessionName)
            if (data.hostId !== attachedHostId) break
            recordStreamMetric('copyModeCancelRequests')
            void runTmuxOnHost(attachedHostId, ['send-keys', '-t', sessionName, '-X', 'cancel']).catch(() => {})
            break
          }
          case 'detach':
            cleanup(true)
            break
          case 'sessions':
            send({ type: 'sessions-list', sessions: data.sessions })
            break
          case 'session-created':
            send({ type: 'session-created', session: data.session })
            break
          case 'ping':
            send({ type: 'pong', timestamp: data.timestamp || Date.now() })
            break
          default:
            send({ type: 'error', message: `Unknown message type: ${data.type}` })
        }
      } catch (err) {
        const errorMessage = err instanceof Error && err.message ? err.message : 'Invalid message format'
        console.error('Stream message error', errorMessage)
        const payload: Record<string, unknown> = { type: 'error', message: errorMessage }
        try {
          const data = JSON.parse(message.toString())
          if (typeof data?.hostId === 'string' && data.hostId.trim()) payload.hostId = data.hostId.trim()
          if (typeof data?.sessionName === 'string' && data.sessionName.trim()) payload.sessionName = data.sessionName.trim()
        } catch {}
        send(payload)
      }
    })
    socket.on('close', () => {
      console.log('Client disconnected from stream')
      cleanup()
      clearInterval(agentStateTimer)
      updateStreamMetric('activeClients', streamPerfMetricsActiveClientsDelta(-1))
      if (agentId) agentManager.unregister(agentId)
    })
    send({ type: 'connected', timestamp: Date.now() })
  })
}
