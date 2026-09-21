import { recordStreamMetric, updateStreamMetric } from '../perf-metrics.js'
import { createTerminalAttachment } from '../terminal-attachment.js'
import { createTerminalOutputSanitizer, hasSubstantiveTerminalContent } from '../terminal-output.js'
import { getAttachSnapshotDelays } from '../attach-snapshot.js'
import { execTmux } from '../tmux-executor.js'
import { agentMonitor } from '../agent-monitor.js'
import { markAgentPaneSeen } from '../agent-state.js'
import { assertSessionAllowed, prepareSessionAttach } from '../tmux-policy.js'
import { parseSessionRef } from '../tmux-target.js'
import { encodeStreamCellBinary, encodeStreamOutputBinary } from '../stream-binary.js'
import { shareLinkStore, type ShareTicket } from '../share-links.js'
import { StreamCellEncoder } from './stream-cell.js'
import { applyScroll, getSessionWindowSize, refreshAttachedClient } from './stream-tmux.js'
import {
  ATTACH_REDRAW_DELAYS,
  CLIENT_BACKPRESSURE_RESYNC_CHARS,
  DEDUP_CHUNK_THRESHOLD,
  OUTPUT_BUFFER_MAX_CHARS,
  OUTPUT_PROFILES,
  REQUEST_REDRAW_DELAYS,
  RESIZE_ACK_OUTPUT_WAIT_MS,
  RESYNC_HYSTERESIS_MS,
  RESYNC_RESET_SEQ,
  SCROLL_MAX_LINES,
  SOCKET_BUFFER_EXTREME_WATERMARK,
  SOCKET_BUFFER_HIGH_WATERMARK,
  SOCKET_FLUSH_DEFER_MS,
  STREAM_CELL_ENABLED,
  STREAM_COMPRESS_ENABLED,
  STREAM_COMPRESS_THRESHOLD,
  type OutputProfileName,
  type TerminalProcess,
} from './stream-config.js'
interface StreamSocketLike {
  readyState: number
  bufferedAmount?: number | undefined
  send: (data: string | Buffer) => void
  close: (code?: number, reason?: string) => void
}
interface PendingResizeAck {
  sessionName: string
  hostId: string
  cols: number
  rows: number
  seq: number
  refreshComplete: boolean
  outputObserved: boolean
  startedAt: number
}
export class StreamSession {
  ptyProcess: TerminalProcess | null = null
  attachedSessionName: string | null = null
  attachedHostId = 'local'
  attachedExclusive = false
  attachedCols = 0
  attachedRows = 0
  outputBuffer = ''
  lastFrame = ''
  dedupDropLogCount = 0
  outputTimer: ReturnType<typeof setTimeout> | null = null
  deferredFlushTimer: ReturnType<typeof setTimeout> | null = null
  outputResyncPending = false
  outputResyncRunning = false
  resyncHysteresisTimer: ReturnType<typeof setTimeout> | null = null
  redrawTimers: ReturnType<typeof setTimeout>[] = []
  outputProfile: OutputProfileName = 'foreground'
  clientBackpressureHigh = false
  binaryOutputEnabled = false
  compressOutputEnabled = false
  cellOutputEnabled = false
  cell = new StreamCellEncoder()
  attachSeq = 0
  attachVisibleOutputObserved = false
  attachSnapshotTimers: ReturnType<typeof setTimeout>[] = []
  pendingResizeAck: PendingResizeAck | null = null
  resizeAckTimer: ReturnType<typeof setTimeout> | null = null
  scrollBuffers = new Map<string, number>()
  scrollRunning = new Set<string>()
  sanitizeTerminalOutput = createTerminalOutputSanitizer()
  constructor(
    private socket: StreamSocketLike,
    private shareTicket: ShareTicket | null,
  ) {
    this.syncOutputProfile('foreground')
  }
  send(data: any) {
    if (this.socket.readyState !== 1) return false
    try {
      this.getSocketBufferedBytes()
      this.socket.send(JSON.stringify(data))
      this.getSocketBufferedBytes()
      return true
    } catch {
      return false
    }
  }
  getSocketBufferedBytes() {
    const buffered = Math.max(0, Number(this.socket.bufferedAmount) || 0)
    updateStreamMetric('socketBufferedBytes', buffered)
    if (buffered >= SOCKET_BUFFER_EXTREME_WATERMARK && this.outputProfile === 'foreground')
      this.syncOutputProfile('background')
    return buffered
  }
  syncOutputProfile(profile: OutputProfileName) {
    const changed = this.outputProfile !== profile
    this.outputProfile = profile
    const current = OUTPUT_PROFILES[profile]
    updateStreamMetric('activeProfile', profile)
    updateStreamMetric('activeFlushInterval', current.flushInterval)
    updateStreamMetric('activeMaxChars', current.maxChars)
    if (changed) recordStreamMetric('profileUpdates')
  }
  sanitizeOutput(chunk: string) {
    recordStreamMetric('sanitizeCalls')
    recordStreamMetric('sanitizeChars', chunk.length)
    return this.sanitizeTerminalOutput(chunk)
  }
  sendTerminalOutput(type: 'output' | 'output_resync', data: string, sessionName: string, hostId: string) {
    if (this.shareTicket && !shareLinkStore.isTicketActive(this.shareTicket)) {
      this.socket.close(1008, 'Share link is unavailable')
      return false
    }
    if (this.socket.readyState !== 1) return false
    try {
      this.getSocketBufferedBytes()
      if (this.binaryOutputEnabled) {
        const rawLen = Buffer.byteLength(data || '', 'utf8')
        const frame = encodeStreamOutputBinary(type, hostId, sessionName, data, {
          compress: this.compressOutputEnabled,
          threshold: STREAM_COMPRESS_THRESHOLD,
        })
        const typeCode = frame[3]
        if (typeCode === 3 || typeCode === 4) {
          recordStreamMetric('compressFrames')
          recordStreamMetric('compressBytesIn', rawLen)
          recordStreamMetric('compressBytesOut', frame.length - 12)
        }
        this.socket.send(frame)
        recordStreamMetric('outputBytes', frame.length)
      } else {
        this.socket.send(JSON.stringify({ type, data, sessionName, hostId }))
        recordStreamMetric('outputBytes', Buffer.byteLength(data || '', 'utf8'))
      }
      this.getSocketBufferedBytes()
      return true
    } catch {
      return false
    }
  }
  sendCellFrame(type: 'cell_snapshot_v2' | 'cell_diff_v2', payload: Buffer, sessionName: string, hostId: string) {
    if (this.socket.readyState !== 1 || !this.binaryOutputEnabled || !this.cellOutputEnabled) return false
    try {
      this.getSocketBufferedBytes()
      const useGzip = this.compressOutputEnabled && type === 'cell_snapshot_v2'
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
      this.socket.send(frame)
      recordStreamMetric('outputBytes', frame.length)
      this.getSocketBufferedBytes()
      return true
    } catch {
      return false
    }
  }
  feedCellAndMaybeSend(kind: 'output' | 'output_resync', data: string, sessionName: string, hostId: string) {
    const result = this.cell.feed(kind, data, this.attachedCols, this.attachedRows)
    if (result.kind === 'skip') return true
    if (result.kind === 'fallback') return false
    if (!this.sendCellFrame(result.type, result.payload, sessionName, hostId)) return false
    recordStreamMetric(result.metric)
    this.cell.markSent()
    return true
  }
  requestLatestFrameResync() {
    if (this.outputResyncPending) {
      if (this.outputBuffer) {
        recordStreamMetric('droppedOutputChars', this.outputBuffer.length)
        this.outputBuffer = ''
      }
      return
    }
    if (this.outputBuffer) recordStreamMetric('droppedOutputChars', this.outputBuffer.length)
    recordStreamMetric('outputResyncRequests')
    this.outputBuffer = ''
    this.lastFrame = ''
    this.sanitizeTerminalOutput = createTerminalOutputSanitizer()
    this.outputResyncPending = true
    if (this.outputTimer) {
      clearTimeout(this.outputTimer)
      this.outputTimer = null
    }
    this.scheduleDeferredFlush()
  }
  // 拥塞 resync 迟滞：调用方在判据首次超限时调用——记 suppressed 并挂
  // RESYNC_HYSTERESIS_MS 复查；到时仍超限才升级 resync。一次性突发
  // （pane resize 重绘、远端输出浪涌）排空后复查不再超限，天然被过滤；
  // 判据由调用方传入，复查沿用时超时的那一份
  maybeResyncCongested(congested: () => boolean) {
    if (this.outputResyncPending || this.resyncHysteresisTimer || !congested()) return
    recordStreamMetric('backpressureSuppressed')
    this.resyncHysteresisTimer = setTimeout(() => {
      this.resyncHysteresisTimer = null
      if (!this.outputResyncPending && congested()) this.requestLatestFrameResync()
    }, RESYNC_HYSTERESIS_MS)
  }
  scheduleDeferredFlush() {
    if (this.deferredFlushTimer) return
    recordStreamMetric('deferredFlushes')
    this.deferredFlushTimer = setTimeout(() => {
      this.deferredFlushTimer = null
      this.flushOutput()
    }, SOCKET_FLUSH_DEFER_MS)
  }
  async flushOutputResync() {
    if (!this.outputResyncPending || this.outputResyncRunning || !this.ptyProcess || !this.attachedSessionName) return
    const sessionName = this.attachedSessionName
    const hostId = this.attachedHostId
    const seq = this.attachSeq
    const pid = this.ptyProcess.pid
    // 代次守卫：await 期间 cleanup/新 attach 后，旧 resync 的 catch/finally
    // 不得再写 pending/running/timer——那些字段已属于新一轮 attach
    const current = () =>
      seq === this.attachSeq &&
      this.attachedSessionName === sessionName &&
      this.attachedHostId === hostId &&
      !!this.ptyProcess
    this.outputResyncRunning = true
    try {
      if (this.getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) {
        this.scheduleDeferredFlush()
        return
      }
      // 恢复握手边界：先发 output_resync 让前端 dispose 队列并复位 xterm
      // （DECSTR 清模式/滚动区/SGR，ED 清屏保留滚动历史），再由 tmux
      // refresh-client 的真实重绘按普通 output 流入——手拼 pane 快照缺
      // 边框/跨行 SGR 延续/光标模式，不能冒充整屏快照
      if (!this.sendTerminalOutput('output_resync', RESYNC_RESET_SEQ, sessionName, hostId)) {
        this.scheduleDeferredFlush()
        return
      }
      // 先放行再 refresh：重绘字节走 onData 普通路径，若在 pending 期到达会被丢
      this.outputResyncPending = false
      if (this.cellOutputEnabled) this.cell.reset(this.attachedCols, this.attachedRows, this.binaryOutputEnabled)
      await this.redrawAttachedClient(hostId, sessionName, pid)
      if (!current()) return
      recordStreamMetric('outputResyncCompleted')
      recordStreamMetric('outputFlushes')
      recordStreamMetric('outputChunks')
    } catch {
      // 重置已发出但 tmux 重绘失败：恢复 pending 走整轮重试，
      // 否则放行普通输出会在清屏画面上叠出半残画面
      if (current()) this.outputResyncPending = true
    } finally {
      if (current()) {
        this.outputResyncRunning = false
        if (this.outputResyncPending) this.scheduleDeferredFlush()
        else if (this.outputBuffer) this.flushOutput()
      }
    }
  }
  // 测试缝：单测可注入受控 refresh 成败，不依赖真实 tmux session
  redrawAttachedClient(hostId: string, sessionName: string, clientPid: number) {
    return refreshAttachedClient(hostId, sessionName, clientPid)
  }
  flushOutput() {
    if (!this.attachedSessionName) return
    if (this.outputResyncPending) {
      if (this.getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) this.scheduleDeferredFlush()
      else void this.flushOutputResync()
      return
    }
    if (!this.outputBuffer) return
    if (this.getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) {
      this.scheduleDeferredFlush()
      return
    }
    const data = this.outputBuffer
    this.outputBuffer = ''
    const isCompleteFrame = data.startsWith('\u001b[?25l') && data.endsWith('\u001b[?25h')
    if (isCompleteFrame && data.length >= DEDUP_CHUNK_THRESHOLD && data === this.lastFrame) {
      recordStreamMetric('droppedDuplicateChunks', data.length)
      if (this.dedupDropLogCount < 30) {
        this.dedupDropLogCount++
        console.warn(`[frame-dedup#${this.dedupDropLogCount}] len=${data.length}`)
      }
      return
    }
    let sent = false
    if (this.cell.active)
      sent = this.feedCellAndMaybeSend('output', data, this.attachedSessionName, this.attachedHostId)
    if (!sent) {
      if (!this.sendTerminalOutput('output', data, this.attachedSessionName, this.attachedHostId)) {
        this.outputBuffer = data + this.outputBuffer
        return
      }
    }
    if (isCompleteFrame) this.lastFrame = data
    recordStreamMetric('outputFlushes')
    recordStreamMetric('outputChunks')
  }
  completeResizeAck() {
    const pending = this.pendingResizeAck
    if (!pending || !pending.refreshComplete || !pending.outputObserved) return
    if (
      !this.ptyProcess ||
      pending.seq !== this.attachSeq ||
      this.attachedSessionName !== pending.sessionName ||
      this.attachedHostId !== pending.hostId ||
      this.attachedCols !== pending.cols ||
      this.attachedRows !== pending.rows
    )
      return
    this.pendingResizeAck = null
    if (this.resizeAckTimer) {
      clearTimeout(this.resizeAckTimer)
      this.resizeAckTimer = null
    }
    // resize→refresh完成→首笔输出→ACK 的全程耗时，定位慢在哪个环节用
    updateStreamMetric('resizeAckWaitMs', Date.now() - pending.startedAt)
    this.flushOutput()
    this.send({
      type: 'resized',
      sessionName: pending.sessionName,
      hostId: pending.hostId,
      cols: pending.cols,
      rows: pending.rows,
    })
  }
  queueOutput(output: string) {
    if (!output) return
    if (this.outputResyncPending) {
      recordStreamMetric('droppedOutputChars', output.length)
      return
    }
    this.outputBuffer += output
    const congestedLimit = this.clientBackpressureHigh ? CLIENT_BACKPRESSURE_RESYNC_CHARS : OUTPUT_BUFFER_MAX_CHARS
    if (this.outputBuffer.length > congestedLimit) {
      // 判据惰性重算：迟滞窗内 clientBackpressureHigh 可能翻转，复查须用当时阈值
      this.maybeResyncCongested(
        () =>
          this.outputBuffer.length >
          (this.clientBackpressureHigh ? CLIENT_BACKPRESSURE_RESYNC_CHARS : OUTPUT_BUFFER_MAX_CHARS),
      )
      return
    }
    const profile = OUTPUT_PROFILES[this.outputProfile]
    if (this.outputBuffer.length >= profile.maxChars) {
      if (this.outputTimer) {
        clearTimeout(this.outputTimer)
        this.outputTimer = null
      }
      this.flushOutput()
      return
    }
    if (this.outputTimer) return
    const flushDelay = profile.flushInterval
    if (
      flushDelay <= 0 ||
      (this.outputProfile === 'foreground' &&
        !this.clientBackpressureHigh &&
        this.getSocketBufferedBytes() < SOCKET_BUFFER_HIGH_WATERMARK / 8 &&
        this.outputBuffer.length >= STREAM_COMPRESS_THRESHOLD &&
        !this.cell.active)
    ) {
      this.flushOutput()
      return
    }
    this.outputTimer = setTimeout(() => {
      this.outputTimer = null
      this.flushOutput()
    }, flushDelay)
  }
  flushScroll(sessionName: string) {
    if (this.scrollRunning.has(sessionName)) return
    const lines = this.scrollBuffers.get(sessionName) || 0
    this.scrollBuffers.delete(sessionName)
    if (!lines) return
    const hostId = this.attachedHostId
    this.scrollRunning.add(sessionName)
    void applyScroll(hostId, sessionName, lines)
      .catch(() => {})
      .finally(() => {
        this.scrollRunning.delete(sessionName)
        if (this.scrollBuffers.has(sessionName)) this.flushScroll(sessionName)
      })
  }
  queueScroll(sessionName: string, hostId: string, lines: number) {
    if (!sessionName || !lines) return
    assertSessionAllowed(sessionName)
    if (hostId !== this.attachedHostId) return
    recordStreamMetric('paneScrollRequests')
    const next = (this.scrollBuffers.get(sessionName) || 0) + lines
    this.scrollBuffers.set(sessionName, Math.max(-SCROLL_MAX_LINES * 4, Math.min(SCROLL_MAX_LINES * 4, next)))
    if (this.scrollRunning.has(sessionName)) return
    this.flushScroll(sessionName)
  }
  cancelCopyMode(sessionName: string, hostId: string) {
    if (!sessionName) return
    assertSessionAllowed(sessionName)
    if (hostId !== this.attachedHostId) return
    recordStreamMetric('copyModeCancelRequests')
    void execTmux(this.attachedHostId, ['send-keys', '-t', sessionName, '-X', 'cancel']).catch(() => {})
  }
  clearRedrawTimers() {
    for (const timer of this.redrawTimers) clearTimeout(timer)
    this.redrawTimers = []
  }
  clearAttachSnapshotTimers() {
    for (const timer of this.attachSnapshotTimers) clearTimeout(timer)
    this.attachSnapshotTimers = []
  }
  // attach 后迟迟看不到可见输出时的兜底：让 tmux 对该 client 做真实重绘，
  // 重绘字节走普通 output 路径恢复画面（含边框/属性/光标），不再手拼快照
  async captureAttachedSnapshot(sessionName: string, seq: number) {
    if (
      !this.ptyProcess ||
      !sessionName ||
      this.attachVisibleOutputObserved ||
      seq !== this.attachSeq ||
      this.attachedSessionName !== sessionName
    )
      return
    try {
      await refreshAttachedClient(this.attachedHostId, sessionName, this.ptyProcess.pid)
    } catch {}
  }
  scheduleAttachSnapshot(sessionName: string, seq: number, delays = getAttachSnapshotDelays()) {
    if (!sessionName) return
    this.clearAttachSnapshotTimers()
    for (const delay of delays) {
      const timer = setTimeout(() => {
        this.attachSnapshotTimers = this.attachSnapshotTimers.filter((item) => item !== timer)
        if (this.attachVisibleOutputObserved || seq !== this.attachSeq || this.attachedSessionName !== sessionName)
          return
        void this.captureAttachedSnapshot(sessionName, seq)
      }, delay)
      this.attachSnapshotTimers.push(timer)
    }
  }
  async refreshAttachedClient(sessionName: string) {
    if (!this.ptyProcess || !sessionName) return
    await refreshAttachedClient(this.attachedHostId, sessionName, this.ptyProcess.pid)
  }
  scheduleClientRedraw(sessionName: string | null = this.attachedSessionName, delays = [48]) {
    if (!sessionName) return
    this.clearRedrawTimers()
    const seq = this.attachSeq
    for (const delay of delays) {
      const timer = setTimeout(() => {
        this.redrawTimers = this.redrawTimers.filter((item) => item !== timer)
        if (seq !== this.attachSeq || this.attachedSessionName !== sessionName) return
        void this.refreshAttachedClient(sessionName).catch(() => {})
      }, delay)
      this.redrawTimers.push(timer)
    }
  }
  requestRedraw(sessionName: string | undefined, hostId: string | undefined) {
    recordStreamMetric('redrawRequests')
    if (!sessionName) return
    assertSessionAllowed(sessionName)
    if (sessionName === this.attachedSessionName && hostId === this.attachedHostId)
      this.scheduleClientRedraw(sessionName, REQUEST_REDRAW_DELAYS)
  }
  cleanup(notify = false) {
    const current = this.ptyProcess
    const detachedSessionName = this.attachedSessionName
    const detachedHostId = this.attachedHostId
    this.attachSeq += 1
    this.pendingResizeAck = null
    if (this.resizeAckTimer) {
      clearTimeout(this.resizeAckTimer)
      this.resizeAckTimer = null
    }
    this.clearRedrawTimers()
    this.clearAttachSnapshotTimers()
    if (current) {
      current.kill()
      this.ptyProcess = null
    }
    this.attachVisibleOutputObserved = false
    this.attachedSessionName = null
    this.attachedHostId = 'local'
    this.attachedExclusive = false
    this.attachedCols = 0
    this.attachedRows = 0
    if (this.outputTimer) {
      clearTimeout(this.outputTimer)
      this.outputTimer = null
    }
    if (this.deferredFlushTimer) {
      clearTimeout(this.deferredFlushTimer)
      this.deferredFlushTimer = null
    }
    if (this.resyncHysteresisTimer) {
      clearTimeout(this.resyncHysteresisTimer)
      this.resyncHysteresisTimer = null
    }
    this.outputBuffer = ''
    this.sanitizeTerminalOutput = createTerminalOutputSanitizer()
    this.outputResyncPending = false
    this.outputResyncRunning = false
    this.clientBackpressureHigh = false
    this.scrollBuffers.clear()
    if (notify) this.send({ type: 'detached', sessionName: detachedSessionName, hostId: detachedHostId })
  }
  async resolveAttachTarget(data: { hostId?: unknown; sessionName?: unknown }) {
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
  async attach(attach: { hostId?: unknown; sessionName?: unknown; exclusive?: boolean; cols?: number; rows?: number }) {
    recordStreamMetric('attachRequests')
    const attachStartedAt = Date.now()
    console.log('Attach requested', {
      hostId: attach.hostId,
      sessionName: attach.sessionName,
      exclusive: !!attach.exclusive,
      cols: attach.cols,
      rows: attach.rows,
    })
    const { hostId, sessionName } = await this.resolveAttachTarget(attach)
    if (this.shareTicket && (hostId !== this.shareTicket.hostId || sessionName !== this.shareTicket.sessionName))
      throw new Error('Share scope does not allow this session')
    if (hostId === 'local') await prepareSessionAttach(sessionName)
    const requestedCols = attach.cols || 80
    const requestedRows = attach.rows || 24
    const exclusive = this.shareTicket ? false : !!attach.exclusive
    if (
      this.ptyProcess &&
      this.attachedSessionName === sessionName &&
      this.attachedExclusive === exclusive &&
      this.attachedHostId === hostId
    ) {
      this.attachVisibleOutputObserved = false
      if (
        exclusive &&
        requestedCols > 0 &&
        requestedRows > 0 &&
        (requestedCols !== this.attachedCols || requestedRows !== this.attachedRows)
      ) {
        this.ptyProcess.resize(requestedCols, requestedRows)
        this.attachedCols = requestedCols
        this.attachedRows = requestedRows
      }
      this.send({
        type: 'attached',
        sessionName,
        hostId,
        cols: this.attachedCols || requestedCols,
        rows: this.attachedRows || requestedRows,
        exclusive,
      })
      this.scheduleClientRedraw(sessionName, ATTACH_REDRAW_DELAYS)
      this.scheduleAttachSnapshot(sessionName, this.attachSeq)
      console.log('Attach completed (reuse)', { sessionName, elapsedMs: Date.now() - attachStartedAt })
      return
    }
    this.cleanup()
    const sharedSize = exclusive ? null : await getSessionWindowSize(hostId, sessionName)
    const cols = sharedSize?.cols || requestedCols
    const rows = sharedSize?.rows || requestedRows
    const created = await createTerminalAttachment({ hostId, sessionName, cols, rows, exclusive })
    this.ptyProcess = created
    this.attachedSessionName = sessionName
    this.attachedHostId = hostId
    this.attachedExclusive = exclusive
    this.attachedCols = cols
    this.attachedRows = rows
    if (this.cellOutputEnabled) this.cell.reset(cols, rows, this.cellOutputEnabled && this.binaryOutputEnabled)
    this.attachVisibleOutputObserved = false
    this.lastFrame = ''
    this.dedupDropLogCount = 0
    const seq = this.attachSeq
    const attachedProcess = this.ptyProcess
    if (!attachedProcess) throw new Error('Terminal attachment failed')
    attachedProcess.onData((output: string) => {
      if (seq !== this.attachSeq) return
      if (this.outputResyncPending) {
        recordStreamMetric('droppedOutputChars', output.length)
        if (this.pendingResizeAck) {
          this.pendingResizeAck.outputObserved = true
          this.completeResizeAck()
        }
        return
      }
      const filtered = this.sanitizeOutput(output)
      if (filtered) {
        if (!this.attachVisibleOutputObserved && hasSubstantiveTerminalContent(filtered))
          this.attachVisibleOutputObserved = true
        this.queueOutput(filtered)
      }
      if (this.pendingResizeAck) {
        this.pendingResizeAck.outputObserved = true
        this.completeResizeAck()
      }
    })
    attachedProcess.onExit((exitCode) => {
      if (seq !== this.attachSeq) return
      const exitedSessionName = this.attachedSessionName
      const exitedHostId = this.attachedHostId
      const exitedExclusive = this.attachedExclusive
      this.flushOutput()
      this.send({
        type: 'session-exit',
        exitCode,
        hostId: exitedHostId,
        sessionName: exitedSessionName,
        exclusive: exitedExclusive,
      })
      this.send({ type: 'detached', hostId: exitedHostId, sessionName: exitedSessionName, exitCode })
      this.ptyProcess = null
      this.attachedSessionName = null
      this.attachedHostId = 'local'
      this.attachedExclusive = false
      this.attachedCols = 0
      this.attachedRows = 0
      this.pendingResizeAck = null
      if (this.resizeAckTimer) {
        clearTimeout(this.resizeAckTimer)
        this.resizeAckTimer = null
      }
      this.clearAttachSnapshotTimers()
      this.clearRedrawTimers()
    })
    this.send({ type: 'attached', sessionName, hostId, cols, rows, exclusive })
    this.scheduleClientRedraw(sessionName, ATTACH_REDRAW_DELAYS)
    this.scheduleAttachSnapshot(sessionName, seq)
    console.log('Attach completed (new)', { sessionName, cols, rows, elapsedMs: Date.now() - attachStartedAt })
  }
  resize(cols: number, rows: number) {
    recordStreamMetric('resizeRequests')
    if (!this.ptyProcess) return
    const nextCols = Math.max(2, Math.round(cols))
    const nextRows = Math.max(1, Math.round(rows))
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows) || !this.attachedSessionName) return
    if (nextCols === this.attachedCols && nextRows === this.attachedRows) {
      this.send({
        type: 'resized',
        sessionName: this.attachedSessionName,
        hostId: this.attachedHostId,
        cols: nextCols,
        rows: nextRows,
      })
      return
    }
    const pending = {
      sessionName: this.attachedSessionName,
      hostId: this.attachedHostId,
      cols: nextCols,
      rows: nextRows,
      seq: this.attachSeq,
      refreshComplete: false,
      outputObserved: false,
      startedAt: Date.now(),
    }
    this.pendingResizeAck = pending
    this.ptyProcess.resize(nextCols, nextRows)
    this.attachedCols = nextCols
    this.attachedRows = nextRows
    if (this.cellOutputEnabled) this.cell.reset(nextCols, nextRows, this.cellOutputEnabled && this.binaryOutputEnabled)
    void this.refreshAttachedClient(pending.sessionName)
      .catch(() => {})
      .finally(() => {
        if (this.pendingResizeAck !== pending) return
        pending.refreshComplete = true
        this.completeResizeAck()
        if (this.pendingResizeAck !== pending) return
        // A fully static pane may emit zero bytes after refresh; bound the
        // output wait so the client-side resize mask cannot stall on it.
        this.resizeAckTimer = setTimeout(() => {
          this.resizeAckTimer = null
          if (this.pendingResizeAck !== pending) return
          pending.outputObserved = true
          this.completeResizeAck()
        }, RESIZE_ACK_OUTPUT_WAIT_MS)
      })
  }
  input(data: string) {
    recordStreamMetric('inputMessages')
    if (this.ptyProcess) this.ptyProcess.write(data)
  }
  markAgentSeen(paneId: string) {
    if (!paneId.startsWith(this.attachedHostId + ':')) return
    agentMonitor.markSeen(paneId) || markAgentPaneSeen(paneId)
  }
  applyCaps(data: { binaryOutput?: boolean; compressOutput?: string; cellOutput?: boolean }) {
    this.binaryOutputEnabled = data.binaryOutput === true
    this.compressOutputEnabled = STREAM_COMPRESS_ENABLED && this.binaryOutputEnabled && data.compressOutput === 'gzip'
    this.cellOutputEnabled = STREAM_CELL_ENABLED && this.binaryOutputEnabled && data.cellOutput === true
    if (this.cellOutputEnabled)
      this.cell.reset(
        this.attachedCols || 80,
        this.attachedRows || 24,
        this.cellOutputEnabled && this.binaryOutputEnabled,
      )
    else this.cell.clear()
    this.send({
      type: 'stream_caps',
      binaryOutput: this.binaryOutputEnabled,
      compressOutput: this.compressOutputEnabled ? 'gzip' : false,
      cellOutput: this.cellOutputEnabled,
    })
  }
  requestCellResync() {
    if (this.cellOutputEnabled && this.attachedSessionName) {
      this.cell.reset(
        this.attachedCols || 80,
        this.attachedRows || 24,
        this.cellOutputEnabled && this.binaryOutputEnabled,
      )
      this.requestLatestFrameResync()
    }
  }
  setProfile(profile: string) {
    if (profile === 'foreground' || profile === 'background' || profile === 'mobile') this.syncOutputProfile(profile)
  }
  setBackpressure(level: string, mobile: boolean) {
    recordStreamMetric('backpressureSignals')
    if (level === 'high') {
      this.clientBackpressureHigh = true
      this.syncOutputProfile(mobile ? 'mobile' : 'background')
      this.maybeResyncCongested(
        () =>
          this.outputBuffer.length >= CLIENT_BACKPRESSURE_RESYNC_CHARS ||
          this.getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK,
      )
    } else if (level === 'normal') {
      this.clientBackpressureHigh = false
      this.syncOutputProfile(mobile ? 'mobile' : 'foreground')
    }
  }
}
