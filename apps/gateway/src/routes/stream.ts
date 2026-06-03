import type { FastifyInstance } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { agentManager } from '../agent-manager.js'
import { assertSessionAllowed, prepareSessionAttach } from '../lib/tmux-policy.js'
import { recordStreamMetric, updateStreamMetric } from '../lib/perf-metrics.js'
import { getHostById } from '../lib/hosts.js'
import { hasSubstantiveTerminalContent } from '../lib/terminal-output.js'
import { parseSessionRef } from '../lib/tmux-target.js'
import { getAttachSnapshotDelays } from '../lib/attach-snapshot.js'

const execFileAsync = promisify(execFile)
export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/stream', { websocket: true }, (connection: SocketStream) => {
    console.log('Client connected to stream')
    const SCROLL_FLUSH_INTERVAL = 16
    const SCROLL_MAX_LINES = 24
    const ATTACH_REDRAW_DELAYS = [48]
    const RESIZE_REDRAW_DELAYS = [100]
    const REQUEST_REDRAW_DELAYS = [48]
    const SOCKET_BUFFER_HIGH_WATERMARK = 1048576
    const SOCKET_BUFFER_EXTREME_WATERMARK = 4194304
    const SOCKET_FLUSH_DEFER_MS = 24
    const OUTPUT_PROFILES = {
      foreground: { flushInterval: 4, maxChars: 24576 },
      background: { flushInterval: 24, maxChars: 98304 },
      mobile: { flushInterval: 12, maxChars: 32768 },
    } as const
    let ptyProcess: pty.IPty | null = null
    let attachedSessionName: string | null = null
    let attachedHostId = 'local'
    let attachedExclusive = false
    let attachedCols = 0
    let attachedRows = 0
    let agentId: string | null = null
    let outputCarry = ''
    let outputBuffer = ''
    let outputTimer: ReturnType<typeof setTimeout> | null = null
    let deferredFlushTimer: ReturnType<typeof setTimeout> | null = null
    let redrawTimers: ReturnType<typeof setTimeout>[] = []
    let outputProfile: keyof typeof OUTPUT_PROFILES = 'foreground'
    let attachSeq = 0
    let attachVisibleOutputObserved = false
    let attachSnapshotTimers: ReturnType<typeof setTimeout>[] = []
    const scrollBuffers = new Map<string, number>()
    const scrollTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const socket = connection.socket
    updateStreamMetric('activeClients', streamPerfMetricsActiveClientsDelta(1))
    syncOutputProfile(outputProfile)
    function streamPerfMetricsActiveClientsDelta(delta: number) {
      const next = Math.max(0, Number((globalThis as any).__tmuxgoActiveClients || 0) + delta)
      ;(globalThis as any).__tmuxgoActiveClients = next
      return next
    }
    function syncOutputProfile(profile: keyof typeof OUTPUT_PROFILES) {
      outputProfile = profile
      const current = OUTPUT_PROFILES[profile]
      updateStreamMetric('activeProfile', profile)
      updateStreamMetric('activeFlushInterval', current.flushInterval)
      updateStreamMetric('activeMaxChars', current.maxChars)
      recordStreamMetric('profileUpdates')
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
    function scheduleDeferredFlush() {
      if (deferredFlushTimer) return
      recordStreamMetric('deferredFlushes')
      deferredFlushTimer = setTimeout(() => {
        deferredFlushTimer = null
        flushOutput()
      }, SOCKET_FLUSH_DEFER_MS)
    }
    function flushOutput() {
      if (!outputBuffer || !attachedSessionName) return
      if (getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) {
        scheduleDeferredFlush()
        return
      }
      const data = outputBuffer
      outputBuffer = ''
      if (!send({ type: 'output', data, sessionName: attachedSessionName, hostId: attachedHostId })) {
        outputBuffer = data + outputBuffer
        return
      }
      recordStreamMetric('outputFlushes')
      recordStreamMetric('outputChunks')
      recordStreamMetric('outputBytes', data.length)
    }
    function queueOutput(output: string) {
      if (!output) return
      outputBuffer += output
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
      outputTimer = setTimeout(() => {
        outputTimer = null
        flushOutput()
      }, profile.flushInterval)
    }
    function resolveHostPassword(host: { password?: string; passwordEnv?: string }) {
      if (host.password) return host.password
      const envName = (host.passwordEnv || '').trim()
      if (!envName) return ''
      return process.env[envName] || ''
    }
    async function hasSshPass() {
      try {
        await execFileAsync('sshpass', ['-V'])
        return true
      } catch {
        return false
      }
    }
    async function runTmuxOnHost(hostId: string, args: string[]) {
      if (hostId !== 'local') return
      await execFileAsync('tmux', args)
    }
    async function applyScroll(sessionName: string, lines: number) {
      if (!lines) return
      if (lines > 0) {
        await runTmuxOnHost(attachedHostId, ['copy-mode', '-e', '-t', sessionName])
      }
      const action = lines > 0 ? 'scroll-up' : 'scroll-down'
      let remaining = Math.abs(lines)
      while (remaining > 0) {
        const step = Math.min(remaining, SCROLL_MAX_LINES)
        await runTmuxOnHost(attachedHostId, ['send-keys', '-t', sessionName, '-X', '-N', String(step), action])
        remaining -= step
      }
    }
    function flushScroll(sessionName: string) {
      scrollTimers.delete(sessionName)
      const lines = scrollBuffers.get(sessionName) || 0
      scrollBuffers.delete(sessionName)
      if (!lines) return
      void applyScroll(sessionName, lines).catch(() => {})
    }
    function queueScroll(sessionName: string, lines: number) {
      if (!sessionName || !lines) return
      const next = (scrollBuffers.get(sessionName) || 0) + lines
      scrollBuffers.set(sessionName, Math.max(-SCROLL_MAX_LINES * 4, Math.min(SCROLL_MAX_LINES * 4, next)))
      const existing = scrollTimers.get(sessionName)
      if (existing) return
      const timer = setTimeout(() => flushScroll(sessionName), SCROLL_FLUSH_INTERVAL)
      scrollTimers.set(sessionName, timer)
    }
    function clearRedrawTimers() {
      for (const timer of redrawTimers) clearTimeout(timer)
      redrawTimers = []
    }
    function clearAttachSnapshotTimers() {
      for (const timer of attachSnapshotTimers) clearTimeout(timer)
      attachSnapshotTimers = []
    }
    async function captureAttachedSnapshot(sessionName: string, seq: number) {
      if (!ptyProcess || !sessionName || attachVisibleOutputObserved || seq !== attachSeq || attachedSessionName !== sessionName) return
      if (attachedHostId !== 'local') return
      try {
        const { stdout } = await execFileAsync('tmux', ['capture-pane', '-e', '-pt', sessionName, '-p'])
        if (!ptyProcess || !sessionName || attachVisibleOutputObserved || seq !== attachSeq || attachedSessionName !== sessionName) return
        const snapshot = String(stdout || '')
        if (!snapshot) return
        attachVisibleOutputObserved = true
        queueOutput(`\u001b[H\u001b[2J${snapshot}`)
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
      if (attachedHostId !== 'local') return
      const pid = String(ptyProcess.pid)
      const { stdout } = await execFileAsync('tmux', ['list-clients', '-t', sessionName, '-F', '#{client_pid}|#{client_name}'])
      const clients = String(stdout).trim().split('\n').filter(Boolean).map((line) => {
        const [clientPid, ...nameParts] = line.split('|')
        return { pid: clientPid, name: nameParts.join('|') }
      }).filter((client) => client.name)
      const owned = clients.filter((client) => client.pid === pid)
      const targets = (owned.length ? owned : clients).map((client) => client.name)
      for (const target of targets) {
        await execFileAsync('tmux', ['refresh-client', '-t', target])
      }
    }
    function scheduleClientRedraw(sessionName: string | null = attachedSessionName, delays = [48]) {
      if (!sessionName) return
      if (attachedHostId !== 'local') return
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
      outputCarry = ''
      for (const timer of scrollTimers.values()) clearTimeout(timer)
      scrollTimers.clear()
      scrollBuffers.clear()
      if (notify) send({ type: 'detached', sessionName: detachedSessionName, hostId: detachedHostId })
    }
    function sanitizeOutput(chunk: string) {
      recordStreamMetric('sanitizeCalls')
      recordStreamMetric('sanitizeChars', chunk.length)
      const merged = outputCarry + chunk
      const cleaned = merged
        .replace(/\u001b\[[0-9;?]*c/g, '')
        .replace(/(?:\u001b\[)?\??(?:\d+;)+\d+c/g, '')
        .replace(/0;(?:\d+;)*\d+c/g, '')
      const trailingEsc = cleaned.match(/\u001b(?:\[[0-9;?]*)?$/)
      const trailingDigits = cleaned.match(/[0-9;]{0,32}c?$/)
      if (trailingEsc && trailingEsc[0] && trailingEsc[0].length < cleaned.length) {
        outputCarry = trailingEsc[0]
        return cleaned.slice(0, cleaned.length - trailingEsc[0].length)
      }
      if (trailingDigits && trailingDigits[0] && trailingDigits[0].includes(';') && trailingDigits[0].length < cleaned.length) {
        outputCarry = trailingDigits[0]
        return cleaned.slice(0, cleaned.length - trailingDigits[0].length)
      }
      outputCarry = ''
      return cleaned
    }
    async function getSessionWindowSize(sessionName: string, hostId: string) {
      if (hostId !== 'local') return null
      try {
        const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', sessionName, '#{window_width}|#{window_height}'])
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
        const data = JSON.parse(message.toString())
        switch (data.type) {
          case 'register':
            agentId = data.host.id
            agentManager.register(data.host.id, data.host.name, data.host.address, socket)
            send({ type: 'registered', agentId: data.host.id })
            break
          case 'attach': {
            recordStreamMetric('attachRequests')
            const { hostId, sessionName } = await resolveAttachTarget(data)
            if (hostId === 'local') await prepareSessionAttach(sessionName)
            const requestedCols = data.cols || 80
            const requestedRows = data.rows || 24
            const exclusive = !!data.exclusive
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
              const target = `${host.user}@${host.address}`
              const sshBaseArgs = ['-p', String(host.port), '-tt', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new', target, '--', 'tmux', 'attach']
              if (exclusive) sshBaseArgs.push('-d')
              else sshBaseArgs.push('-f', 'ignore-size,active-pane')
              sshBaseArgs.push('-t', sessionName)
              const hostPassword = resolveHostPassword(host)
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
              if (exclusive) {
                attachArgs.push('-d')
              } else {
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
            attachVisibleOutputObserved = false
            const seq = attachSeq
            ptyProcess.onData((output: string) => {
              if (seq !== attachSeq) return
              const filtered = sanitizeOutput(output)
              if (filtered) {
                if (hasSubstantiveTerminalContent(filtered)) attachVisibleOutputObserved = true
                queueOutput(filtered)
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
              clearAttachSnapshotTimers()
              clearRedrawTimers()
            })
            send({ type: 'attached', sessionName, hostId, cols, rows, exclusive })
            scheduleClientRedraw(sessionName, ATTACH_REDRAW_DELAYS)
            scheduleAttachSnapshot(sessionName, seq)
            break
          }
          case 'resize':
            recordStreamMetric('resizeRequests')
            if (ptyProcess) {
              ptyProcess.resize(data.cols, data.rows)
              attachedCols = data.cols
              attachedRows = data.rows
              scheduleClientRedraw(attachedSessionName, RESIZE_REDRAW_DELAYS)
            }
            break
          case 'redraw': {
            const sessionName = data.sessionName
            if (!sessionName) break
            assertSessionAllowed(sessionName)
            if (sessionName === attachedSessionName && data.hostId === attachedHostId) scheduleClientRedraw(sessionName, REQUEST_REDRAW_DELAYS)
            break
          }
          case 'input':
            recordStreamMetric('inputMessages')
            if (ptyProcess) ptyProcess.write(data.data)
            break
          case 'stream_profile':
            if (data.profile === 'foreground' || data.profile === 'background' || data.profile === 'mobile') syncOutputProfile(data.profile)
            break
          case 'stream_backpressure':
            recordStreamMetric('backpressureSignals')
            if (data.level === 'high') syncOutputProfile(data.mobile ? 'mobile' : 'background')
            if (data.level === 'normal') syncOutputProfile(data.mobile ? 'mobile' : 'foreground')
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
            if (attachedHostId === 'local') void execFileAsync('tmux', ['send-keys', '-t', sessionName, '-X', 'cancel']).catch(() => {})
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
      } catch {
        send({ type: 'error', message: 'Invalid message format' })
      }
    })
    socket.on('close', () => {
      console.log('Client disconnected from stream')
      cleanup()
      updateStreamMetric('activeClients', streamPerfMetricsActiveClientsDelta(-1))
      if (agentId) agentManager.unregister(agentId)
    })
    send({ type: 'connected', timestamp: Date.now() })
  })
}
