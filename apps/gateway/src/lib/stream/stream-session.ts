import { recordStreamMetric, updateStreamMetric } from '../perf-metrics.js'
import { createTerminalAttachment } from '../terminal-attachment.js'
import { createTerminalOutputSanitizer, hasSubstantiveTerminalContent } from '../terminal-output.js'
import { getAttachSnapshotDelays } from '../attach-snapshot.js'
import { execTmux } from '../tmux-executor.js'
import { agentMonitor } from '../agent-monitor.js'
import { markAgentPaneSeen } from '../agent-state.js'
import { assertSessionAllowed, prepareSessionAttach } from '../tmux-policy.js'
import { parseSessionRef } from '../tmux-target.js'
import {
  encodeStreamCellBinary,
  encodeStreamCellBinaryAsync,
  encodeStreamCellBinaryCompact,
  encodeStreamCellBinaryCompactAsync,
  encodeStreamOutputBinary,
  encodeStreamOutputBinaryAsync,
  encodeStreamOutputBinaryCompact,
  encodeStreamOutputBinaryCompactAsync,
  shouldMaybeGzip,
} from '../stream-binary.js'
import { StreamRouteDictionary } from './stream-route.js'
import { shareLinkStore, type ShareTicket } from '../share-links.js'
import { StreamCellEncoder } from './stream-cell.js'
import { applyScroll, getSessionWindowSize, refreshAttachedClient, resizeSessionWindow } from './stream-tmux.js'
import { acquireSharedTerminal, type SharedTerminal } from './shared-terminal.js'
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
  STREAM_COMPACT_ENABLED,
  STREAM_COMPRESS_ENABLED,
  STREAM_FANOUT_ENABLED,
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
// 同 session 全部 stream 连接的 window 尺寸仲裁。
// tmux window 尺寸由"最近主张"的 client 决定（window-size latest / aggressive-resize）：
// 其余附着——ignore-size 的共享/被动端、被抢占的独占端——client pty 尺寸不再等于
// window，tmux 只在屏幕左上角画 window 区域 → 画面残缺且不随时间自愈；驱动端
// 断开后 window 也不会回弹。这里在独占 attach/resize/连接断开/窗口切换后做一次
// reconcile：读真实 window 尺寸，把所有连接的 pty 同步过去并推 window-size 事件；
// 独占 owner 断开时由最近主张的幸存独占端拉回期望尺寸。
const streamPeers = new Map<string, Set<StreamSession>>()
const windowSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
let assertOrderSeq = 0
// 会话级唯一独占所有权：同一 host+session 同时只允许一个 exclusive 写端。
// 多端/多标签同时 pageActive 时后到的 exclusive claim 会踢掉前任，
// 保证「当前在用」等同单实例，失焦/被抢端不再抢 window-size 或写输入。
const exclusiveOwners = new Map<string, StreamSession>()
const WINDOW_SYNC_DELAY_MS = 80
const WINDOW_SYNC_SETTLE_MS = 60
function peerKey(hostId: string, sessionName: string) {
  return `${hostId}\0${sessionName}`
}
// 测试缝：reconcile 的 window 尺寸查询可注入，不依赖真实 tmux session
let windowSizeQuery: typeof getSessionWindowSize = getSessionWindowSize
export function setWindowSizeQueryForTest(fn: typeof getSessionWindowSize | null) {
  windowSizeQuery = fn ?? getSessionWindowSize
}
export function resetExclusiveOwnershipForTest() {
  exclusiveOwners.clear()
}
export function claimExclusiveOwnership(session: StreamSession) {
  if (!session.attachedSessionName) return
  const key = peerKey(session.attachedHostId, session.attachedSessionName)
  const prev = exclusiveOwners.get(key)
  if (prev && prev !== session) prev.demoteFromExclusive()
  exclusiveOwners.set(key, session)
  session.exclusiveOwnerKey = key
}
export function releaseExclusiveOwnership(session: StreamSession) {
  if (session.exclusiveOwnerKey && exclusiveOwners.get(session.exclusiveOwnerKey) === session) {
    exclusiveOwners.delete(session.exclusiveOwnerKey)
  }
  session.exclusiveOwnerKey = null
}
export function schedulePeerWindowSync(hostId: string, sessionName: string, delay = WINDOW_SYNC_DELAY_MS) {
  const key = peerKey(hostId, sessionName)
  if (windowSyncTimers.has(key)) return
  const timer = setTimeout(() => {
    windowSyncTimers.delete(key)
    void reconcileWindowPeers(key).catch(() => {})
  }, delay)
  windowSyncTimers.set(key, timer)
}
async function reconcileWindowPeers(key: string) {
  const peers = streamPeers.get(key)
  if (!peers || !peers.size) return
  const [hostId, sessionName] = key.split('\0')
  if (!hostId || !sessionName) return
  let win = await windowSizeQuery(hostId, sessionName).catch(() => null)
  // assertSeq 最大的独占端是 window 尺寸的最近主张者：它与 window 不一致说明
  // tmux 读数落在主张前，或 owner 已断开且 tmux 未回弹——由它拉回期望尺寸；
  // 其它 window-size 策略（smallest 等）下重读的实际尺寸仍为权威
  const champion = [...peers].reduce<StreamSession | null>(
    (best, peer) =>
      peer.ptyProcess &&
      peer.attachedExclusive &&
      peer.isExclusiveOwner() &&
      peer.desiredCols > 0 &&
      (!best || peer.assertSeq > best.assertSeq)
        ? peer
        : best,
    null,
  )
  let restored: { cols: number; rows: number } | null = null
  if (champion && (!win || champion.desiredCols !== win.cols || champion.desiredRows !== win.rows)) {
    champion.applyWindowSize(champion.desiredCols, champion.desiredRows, true)
    restored = { cols: champion.desiredCols, rows: champion.desiredRows }
  } else if (!champion) {
    // 无任何存活 owner：window 会停在断开者/末次主张的尺寸上（tmux 不自动回弹）。
    // 由被降级但仍附着的端里主张代次最大者拉回它独占时的尺寸——它多半就是
    // 即将回前台的端；此分支只在无人持有所有权时进入，故后台/旁观端不会
    // 覆盖正被使用的 window（尺寸依据在 demote 时留存，见 demoteFromExclusive）
    const fallback = [...peers].reduce<StreamSession | null>(
      (best, peer) =>
        peer.ptyProcess &&
        peer.lastExclusiveCols > 0 &&
        peer.lastExclusiveRows > 0 &&
        (!best || peer.lastExclusiveSeq > best.lastExclusiveSeq)
          ? peer
          : best,
      null,
    )
    if (fallback && (!win || fallback.lastExclusiveCols !== win.cols || fallback.lastExclusiveRows !== win.rows)) {
      fallback.applyWindowSize(fallback.lastExclusiveCols, fallback.lastExclusiveRows, true)
      restored = { cols: fallback.lastExclusiveCols, rows: fallback.lastExclusiveRows }
    }
  }
  if (restored) {
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SYNC_SETTLE_MS))
    win = await windowSizeQuery(hostId, sessionName).catch(() => win)
    if (!win || win.cols !== restored.cols || win.rows !== restored.rows) {
      // ignore-size 附着（非 fanout 共享端）pty resize 不驱动 window：
      // 直连 resize-window 兜底把 window 拉到目标尺寸
      await resizeSessionWindow(hostId, sessionName, restored.cols, restored.rows).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, WINDOW_SYNC_SETTLE_MS))
      win = await windowSizeQuery(hostId, sessionName).catch(() => win)
    }
  }
  if (!win || win.cols <= 0 || win.rows <= 0) return
  for (const peer of peers) peer.applyWindowSize(win.cols, win.rows)
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
  // fan-out 枢纽：非空表示 ptyProcess 指向共享 SharedTerminal.PTY，kill/resize 归 hub 管
  sharedHub: SharedTerminal | null = null
  attachedSessionName: string | null = null
  attachedHostId = 'local'
  attachedExclusive = false
  // 被动旁观附着（后台/失焦页）：丢弃一切会话级写操作，见 input/queueScroll
  attachedPassive = false
  exclusiveOwnerKey: string | null = null
  attachedCols = 0
  attachedRows = 0
  // 独占端期望的 window 尺寸与主张代次：reconcile 用最近主张者（assertSeq 最大）
  // 恢复 owner 断开后的 window 尺寸
  desiredCols = 0
  desiredRows = 0
  assertSeq = 0
  // 被降级端最近一次独占主张的留存：desired 在降级时清零，若无留存，owner
  // 断开后再无 champion 可恢复 window。仅 reconcile 的 fallback 分支读它——
  // 不是尺寸主张，不影响在任 owner 的仲裁
  lastExclusiveCols = 0
  lastExclusiveRows = 0
  lastExclusiveSeq = 0
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
  compactHeaderEnabled = false
  routes = new StreamRouteDictionary()
  private announcedRoutes = new Set<number>()
  cell = new StreamCellEncoder()
  attachSeq = 0
  attachVisibleOutputObserved = false
  attachRefreshTimers: ReturnType<typeof setTimeout>[] = []
  // attach 重绘合并状态：主动重绘（ATTACH_REDRAW_DELAYS）与无输出兜底
  // （attach-snapshot delays）原是两路独立定时器，48ms 槽位撞车会在同一
  // 时间窗双发 refresh-client。合并后共用本状态：同一 attachSeq+hostId+
  // sessionName 只许一个在途 refresh；首个有效输出确认后 done，剩余槽位
  // 空转；失败只留一次有界重试（failures 上限），tmux 故障不会无限刷
  attachRefresh: {
    seq: number
    sessionName: string
    hostId: string
    failures: number
    inFlight: Promise<void> | null
    done: boolean
  } | null = null
  pendingResizeAck: PendingResizeAck | null = null
  resizeAckTimer: ReturnType<typeof setTimeout> | null = null
  scrollBuffers = new Map<string, number>()
  scrollRunning = new Set<string>()
  sanitizeTerminalOutput = createTerminalOutputSanitizer()
  // 边界（resync 重建 / 新 attach 首轮）先走 heavy 完整清洗，稳态回 light 只剥 DA
  sanitizeMode: 'light' | 'heavy' = 'light'
  // 同一 WebSocket 的帧 FIFO 发送链：gzip 走 zlib 线程池异步完成，期间到达
  // 的帧（无需压缩的小帧、控制消息、resync 后的 output）必须挂到链尾排队，
  // 否则会超车造成帧序错乱。链空闲且任务同步完成时直接返回同步结果，
  // 不为统一 async 而白白引入微任务延迟。
  private sendChainTail: Promise<void> = Promise.resolve()
  private sendChainDepth = 0
  private enqueueFrame(task: () => boolean | Promise<boolean>): boolean | Promise<boolean> {
    if (this.sendChainDepth === 0) {
      let result: boolean | Promise<boolean>
      try {
        result = task()
      } catch {
        return false
      }
      // 同步完成（无需压缩的快路径）：零延迟返回
      if (typeof result === 'boolean') return result
      // 异步任务已启动：成为链头，后续帧只能排它后面
      this.sendChainDepth = 1
      const head = result.then(
        (ok) => ok,
        () => false,
      )
      this.sendChainTail = head.then(() => {
        this.sendChainDepth--
      })
      return head
    }
    this.sendChainDepth++
    const next = this.sendChainTail.then(async () => {
      try {
        return await task()
      } catch {
        return false
      }
    })
    this.sendChainTail = next.then(() => {
      this.sendChainDepth--
    })
    return next
  }
  constructor(
    private socket: StreamSocketLike,
    private shareTicket: ShareTicket | null,
  ) {
    this.syncOutputProfile('foreground')
  }
  send(data: any): boolean | Promise<boolean> {
    // 任务内校验 attachSeq：cleanup/新 attach 后旧 epoch 在途帧作废，
    // 不得把上一轮的输出/控制消息写进新一轮会话
    const seq = this.attachSeq
    return this.enqueueFrame(() => {
      if (seq !== this.attachSeq) return false
      if (this.socket.readyState !== 1) return false
      try {
        this.getSocketBufferedBytes()
        this.socket.send(JSON.stringify(data))
        this.getSocketBufferedBytes()
        return true
      } catch {
        return false
      }
    })
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
    return this.sanitizeTerminalOutput(chunk, this.sanitizeMode)
  }
  sendTerminalOutput(
    type: 'output' | 'output_resync',
    data: string,
    sessionName: string,
    hostId: string,
  ): boolean | Promise<boolean> {
    if (this.shareTicket && !shareLinkStore.isTicketActive(this.shareTicket)) {
      this.socket.close(1008, 'Share link is unavailable')
      return false
    }
    if (this.socket.readyState !== 1) return false
    const seq = this.attachSeq
    // route announce must enqueue before the binary frame (same send chain FIFO)
    const routeIdx = this.binaryOutputEnabled ? this.ensureRoute(hostId, sessionName) : null
    if (!this.binaryOutputEnabled) {
      return this.enqueueFrame(() => {
        if (seq !== this.attachSeq || this.socket.readyState !== 1) return false
        try {
          this.getSocketBufferedBytes()
          this.socket.send(JSON.stringify({ type, data, sessionName, hostId }))
          recordStreamMetric('outputBytes', Buffer.byteLength(data || '', 'utf8'))
          this.getSocketBufferedBytes()
          return true
        } catch {
          return false
        }
      })
    }
    const rawLen = Buffer.byteLength(data || '', 'utf8')
    const force = type === 'output_resync'
    // 阈值判断同步完成（resync 无视阈值强制尝试），只有真需要压缩才进线程池
    const tryCompress = shouldMaybeGzip(rawLen, this.compressOutputEnabled, STREAM_COMPRESS_THRESHOLD, force)
    if (!tryCompress) {
      // 小帧/未启用压缩：同步编码 + 发送链快路径（链空闲即刻发出）
      return this.enqueueFrame(() => {
        if (seq !== this.attachSeq || this.socket.readyState !== 1) return false
        try {
          this.getSocketBufferedBytes()
          const encodeOpts = {
            compress: this.compressOutputEnabled,
            threshold: STREAM_COMPRESS_THRESHOLD,
          }
          const frame =
            routeIdx != null
              ? encodeStreamOutputBinaryCompact(type, routeIdx, data, encodeOpts)
              : encodeStreamOutputBinary(type, hostId, sessionName, data, encodeOpts)
          this.socket.send(frame)
          recordStreamMetric('outputBytes', frame.length)
          this.getSocketBufferedBytes()
          return true
        } catch {
          return false
        }
      })
    }
    // 需要压缩：zlib 异步执行不堵事件循环；经发送链保证与前后帧的 FIFO
    return this.enqueueFrame(async () => {
      if (seq !== this.attachSeq || this.socket.readyState !== 1) return false
      try {
        this.getSocketBufferedBytes()
        const encodeOpts = {
          compress: this.compressOutputEnabled,
          threshold: STREAM_COMPRESS_THRESHOLD,
        }
        const { frame, gzipFailed } =
          routeIdx != null
            ? await encodeStreamOutputBinaryCompactAsync(type, routeIdx, data, encodeOpts)
            : await encodeStreamOutputBinaryAsync(type, hostId, sessionName, data, encodeOpts)
        // gzip 失败：encode 内已回退明文，此处只记 metric，不断连不丢帧
        if (gzipFailed) recordStreamMetric('compressFailures')
        const typeCode = frame[3]
        if (typeCode === 3 || typeCode === 4) {
          recordStreamMetric('compressFrames')
          recordStreamMetric('compressBytesIn', rawLen)
          recordStreamMetric('compressBytesOut', frame.length - 12)
        }
        // 压缩期间连接可能已关闭：写前复查，避免向关闭的 socket 写入
        if (this.socket.readyState !== 1) return false
        this.socket.send(frame)
        recordStreamMetric('outputBytes', frame.length)
        this.getSocketBufferedBytes()
        return true
      } catch {
        return false
      }
    })
  }
  sendCellFrame(
    type: 'cell_snapshot_v2' | 'cell_diff_v2',
    payload: Buffer,
    sessionName: string,
    hostId: string,
  ): boolean | Promise<boolean> {
    if (this.socket.readyState !== 1 || !this.binaryOutputEnabled || !this.cellOutputEnabled) return false
    const seq = this.attachSeq
    const useGzip = this.compressOutputEnabled && type === 'cell_snapshot_v2'
    const isSnapshot = type === 'cell_snapshot_v2'
    const routeIdx = this.ensureRoute(hostId, sessionName)
    const tryCompress = shouldMaybeGzip(payload.length, useGzip, isSnapshot ? 0 : STREAM_COMPRESS_THRESHOLD)
    if (!tryCompress) {
      return this.enqueueFrame(() => {
        if (seq !== this.attachSeq || this.socket.readyState !== 1) return false
        try {
          this.getSocketBufferedBytes()
          const encodeOpts = { compress: useGzip, threshold: STREAM_COMPRESS_THRESHOLD }
          const frame =
            routeIdx != null
              ? encodeStreamCellBinaryCompact(type, routeIdx, payload, encodeOpts)
              : encodeStreamCellBinary(type, hostId, sessionName, payload, encodeOpts)
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
      })
    }
    return this.enqueueFrame(async () => {
      if (seq !== this.attachSeq || this.socket.readyState !== 1) return false
      try {
        this.getSocketBufferedBytes()
        const encodeOptsCell = { compress: useGzip, threshold: STREAM_COMPRESS_THRESHOLD }
        const { frame, gzipFailed } =
          routeIdx != null
            ? await encodeStreamCellBinaryCompactAsync(type, routeIdx, payload, encodeOptsCell)
            : await encodeStreamCellBinaryAsync(type, hostId, sessionName, payload, encodeOptsCell)
        if (gzipFailed) recordStreamMetric('compressFailures')
        const typeCode = frame[3]
        if (typeCode === 6 || typeCode === 8) {
          recordStreamMetric('compressFrames')
          recordStreamMetric('compressBytesIn', payload.length)
          recordStreamMetric('compressBytesOut', frame.length - 12)
        }
        if (this.socket.readyState !== 1) return false
        this.socket.send(frame)
        recordStreamMetric('outputBytes', frame.length)
        this.getSocketBufferedBytes()
        return true
      } catch {
        return false
      }
    })
  }
  feedCellAndMaybeSend(
    kind: 'output' | 'output_resync',
    data: string,
    sessionName: string,
    hostId: string,
  ): boolean | Promise<boolean> {
    const result = this.cell.feed(kind, data, this.attachedCols, this.attachedRows)
    if (result.kind === 'skip') return true
    if (result.kind === 'fallback') return false
    const sent = this.sendCellFrame(result.type, result.payload, sessionName, hostId)
    if (sent === false) return false
    // 帧体已在 feed 时编好并进入 FIFO 链：baseSeq 立即前移，后续 diff 以本帧
    // 为基准——不能等异步发送 resolve 再 markSent，否则两帧间隙 feed 会算错基准
    recordStreamMetric(result.metric)
    this.cell.markSent()
    return sent
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
    // resync 边界：重建 carry 并切 heavy，重绘首轮做完整噪音清洗
    this.sanitizeTerminalOutput = createTerminalOutputSanitizer()
    this.sanitizeMode = 'heavy'
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
      // cell 模式禁止带 ESC[2J 的整屏清屏：后续 cell snapshot 在 DEC 2026
      // 同步块内原地重画，先清屏会造成拥塞恢复时的肉眼闪烁
      const resyncBoundary = this.cellOutputEnabled ? RESYNC_RESET_SEQ.replace('\u001b[2J', '') : RESYNC_RESET_SEQ
      // 压缩时经发送链异步完成：必须等 resync 帧真正发出再放行后续 output，
      // 保证「resync → 重绘 output」的帧序
      const sent = this.sendTerminalOutput('output_resync', resyncBoundary, sessionName, hostId)
      const ok = typeof sent === 'boolean' ? sent : await sent
      if (!ok) {
        if (current()) this.scheduleDeferredFlush()
        return
      }
      if (!current()) return
      // 先放行再 refresh：重绘字节走 onData 普通路径，若在 pending 期到达会被丢
      this.outputResyncPending = false
      if (this.cellOutputEnabled) this.cell.reset(this.attachedCols, this.attachedRows, this.binaryOutputEnabled)
      // 共享 hub 权衡：单 tmux client 的 refresh-client 无法只刷请求端——重绘
      // 进共享 PTY 后扇出全部订阅者。本端边界已发，给其它订阅者补同款
      // output_resync 边界（except 排除本端防重复清屏），换取不拆 PTY
      if (this.sharedHub) this.sharedHub.broadcastRedrawBoundary(this)
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
  registerPeer() {
    if (!this.attachedSessionName) return
    const key = peerKey(this.attachedHostId, this.attachedSessionName)
    let set = streamPeers.get(key)
    if (!set) {
      set = new Set()
      streamPeers.set(key, set)
    }
    set.add(this)
  }
  unregisterPeer() {
    if (!this.attachedSessionName) return
    const key = peerKey(this.attachedHostId, this.attachedSessionName)
    const set = streamPeers.get(key)
    if (set && set.delete(this) && !set.size) streamPeers.delete(key)
  }
  // 由 reconcile 调用：把本 client 的 pty 同步到 window 实际尺寸并推 window-size
  // 事件让前端跟随。对 ignore-size client 是纯视图同步；对独占 client 是等值
  // 尺寸主张（实测 resize 到与 window 相同尺寸不会抢占 window）
  applyWindowSize(cols: number, rows: number, force = false) {
    if (!this.ptyProcess || !this.attachedSessionName || cols <= 0 || rows <= 0) return
    if (!force && cols === this.attachedCols && rows === this.attachedRows) return
    // 在途 resize 的目标尺寸已被仲裁推翻：completeResizeAck 的 attachedCols
    // 守卫不成立会让 pending 永久残留，作废后由 window-size 事件接管确认
    if (this.pendingResizeAck && (this.pendingResizeAck.cols !== cols || this.pendingResizeAck.rows !== rows)) {
      this.pendingResizeAck = null
      if (this.resizeAckTimer) {
        clearTimeout(this.resizeAckTimer)
        this.resizeAckTimer = null
      }
    }
    if (this.sharedHub) {
      // 共享 PTY 只允许仲裁 force 或 exclusive owner 主张尺寸；其余 peer
      // （ignore-size 旁观端）只同步本地视图 + window-size 事件，避免互抢
      if (force || (this.attachedExclusive && this.isExclusiveOwner())) {
        if (force || cols !== this.sharedHub.cols || rows !== this.sharedHub.rows) this.sharedHub.resizePty(cols, rows)
      }
    } else {
      this.ptyProcess.resize(cols, rows)
    }
    this.attachedCols = cols
    this.attachedRows = rows
    if (this.cellOutputEnabled) this.cell.reset(cols, rows, this.cellOutputEnabled && this.binaryOutputEnabled)
    this.send({
      type: 'window-size',
      sessionName: this.attachedSessionName,
      hostId: this.attachedHostId,
      cols,
      rows,
    })
  }
  flushOutput(): boolean | Promise<boolean> | undefined {
    if (!this.attachedSessionName) return
    if (this.outputResyncPending) {
      if (this.getSocketBufferedBytes() >= SOCKET_BUFFER_HIGH_WATERMARK) this.scheduleDeferredFlush()
      else void this.flushOutputResync()
      return
    }
    if (!this.outputBuffer) {
      // buffer 已空但发送链仍有在途异步帧（gzip）：返回链尾让调用方可等待，
      // 否则 queueOutput 内联 flush 后外层再 flush 会误判「已发出」而抢跑断言
      if (this.sendChainDepth > 0) return this.sendChainTail.then(() => true)
      return
    }
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
    const seq = this.attachSeq
    let sent: boolean | Promise<boolean>
    if (this.cell.active) {
      const cellSent = this.feedCellAndMaybeSend('output', data, this.attachedSessionName, this.attachedHostId)
      // Promise = cell 帧已进发送链（保序在途）；false = 解析回退/发送失败 → 走 ANSI 路径
      if (cellSent !== false) sent = cellSent
      else sent = this.sendTerminalOutput('output', data, this.attachedSessionName, this.attachedHostId)
    } else {
      sent = this.sendTerminalOutput('output', data, this.attachedSessionName, this.attachedHostId)
    }
    if (sent === false) {
      this.outputBuffer = data + this.outputBuffer
      return false
    }
    if (sent === true) {
      if (isCompleteFrame) this.lastFrame = data
      recordStreamMetric('outputFlushes')
      recordStreamMetric('outputChunks')
      return true
    }
    // 异步（压缩）路径：帧已在链上按序发送，resolve 后再记账。
    // 发送失败仅在同 epoch 时回填 buffer 重试——cleanup/新 attach 后回填
    // 会把旧一轮 data 污染进新一轮 outputBuffer
    return sent.then((ok) => {
      if (!ok) {
        if (seq === this.attachSeq) this.outputBuffer = data + this.outputBuffer
        return false
      }
      if (isCompleteFrame) this.lastFrame = data
      recordStreamMetric('outputFlushes')
      recordStreamMetric('outputChunks')
      return true
    })
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
    // copy-mode 滚动是 pane 全局状态，被动 client 滚动会改所有旁观者的视图
    if (this.attachedPassive || hostId !== this.attachedHostId) return
    recordStreamMetric('paneScrollRequests')
    const next = (this.scrollBuffers.get(sessionName) || 0) + lines
    this.scrollBuffers.set(sessionName, Math.max(-SCROLL_MAX_LINES * 4, Math.min(SCROLL_MAX_LINES * 4, next)))
    if (this.scrollRunning.has(sessionName)) return
    this.flushScroll(sessionName)
  }
  cancelCopyMode(sessionName: string, hostId: string) {
    if (!sessionName) return
    assertSessionAllowed(sessionName)
    if (this.attachedPassive || hostId !== this.attachedHostId) return
    recordStreamMetric('copyModeCancelRequests')
    void execTmux(this.attachedHostId, ['send-keys', '-t', sessionName, '-X', 'cancel']).catch(() => {})
  }
  clearRedrawTimers() {
    for (const timer of this.redrawTimers) clearTimeout(timer)
    this.redrawTimers = []
  }
  clearAttachRefreshTimers() {
    for (const timer of this.attachRefreshTimers) clearTimeout(timer)
    this.attachRefreshTimers = []
  }
  async refreshAttachedClient(sessionName: string) {
    if (!this.ptyProcess || !sessionName) return
    // 共享 PTY 的 refresh-client 重绘字节会扇出全部订阅者，普通 output 无
    // 复位语义会让旧端整屏叠加花屏——refresh 前先广播 output_resync 边界
    // （含本端），各接收端按原子替换处理，不依赖 tmux 恰好发清屏序列
    if (this.sharedHub) this.sharedHub.broadcastRedrawBoundary()
    await refreshAttachedClient(this.attachedHostId, sessionName, this.ptyProcess.pid)
  }
  // attach 重绘合并调度：两路延时去重排序后各触发一次，全部汇入
  // runAttachRefresh 共享 dedup 状态
  scheduleAttachRefresh(sessionName: string, seq: number) {
    if (!sessionName) return
    this.clearAttachRefreshTimers()
    this.attachRefresh = {
      seq,
      sessionName,
      hostId: this.attachedHostId,
      failures: 0,
      inFlight: null,
      done: false,
    }
    const delays = [...new Set([...ATTACH_REDRAW_DELAYS, ...getAttachSnapshotDelays()])].sort((a, b) => a - b)
    for (const delay of delays) {
      const timer = setTimeout(() => {
        this.attachRefreshTimers = this.attachRefreshTimers.filter((item) => item !== timer)
        void this.runAttachRefresh(sessionName, seq)
      }, delay)
      this.attachRefreshTimers.push(timer)
    }
  }
  // attach 兜底槽位的统一出口（合并协议见 attachRefresh 字段注释）。
  // inFlight 复用合并并发触发；refreshAttachedClient 拒绝计入 failures，
  // 第二次失败即 done——只保留一次有界重试
  private runAttachRefresh(sessionName: string, seq: number): Promise<void> | undefined {
    const s = this.attachRefresh
    if (!s || s.seq !== seq || s.sessionName !== sessionName) return
    if (
      s.done ||
      seq !== this.attachSeq ||
      this.attachedSessionName !== sessionName ||
      this.attachedHostId !== s.hostId ||
      !this.ptyProcess
    )
      return
    if (this.attachVisibleOutputObserved) {
      s.done = true
      return
    }
    if (s.inFlight) return s.inFlight
    if (s.failures >= 2) {
      s.done = true
      return
    }
    recordStreamMetric('attachRefreshExecs')
    const work = this.refreshAttachedClient(sessionName).then(
      () => {},
      () => {
        if (s === this.attachRefresh) {
          s.failures += 1
          recordStreamMetric('attachRefreshFailures')
        }
      },
    )
    s.inFlight = work
    void work.finally(() => {
      if (s === this.attachRefresh) s.inFlight = null
    })
    return work
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
    releaseExclusiveOwnership(this)
    this.unregisterPeer()
    this.attachSeq += 1
    this.pendingResizeAck = null
    if (this.resizeAckTimer) {
      clearTimeout(this.resizeAckTimer)
      this.resizeAckTimer = null
    }
    this.clearRedrawTimers()
    this.clearAttachRefreshTimers()
    this.attachRefresh = null
    if (this.sharedHub) {
      const hub = this.sharedHub
      this.sharedHub = null
      this.ptyProcess = null
      // 最后一个订阅者离开时 hub 内部才 kill PTY
      hub.unsubscribe(this)
    } else if (current) {
      current.kill()
      this.ptyProcess = null
    }
    this.attachVisibleOutputObserved = false
    this.attachedSessionName = null
    this.attachedHostId = 'local'
    this.attachedExclusive = false
    this.attachedPassive = false
    this.attachedCols = 0
    this.attachedRows = 0
    this.desiredCols = 0
    this.desiredRows = 0
    this.lastExclusiveCols = 0
    this.lastExclusiveRows = 0
    this.lastExclusiveSeq = 0
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
    this.routes.clear()
    this.announcedRoutes.clear()
    this.sanitizeMode = 'light'
    this.outputResyncPending = false
    this.outputResyncRunning = false
    this.clientBackpressureHigh = false
    this.scrollBuffers.clear()
    if (notify) this.send({ type: 'detached', sessionName: detachedSessionName, hostId: detachedHostId })
    // 本端 client 消失后 tmux 不回弹 window 尺寸：调度仲裁让幸存的最近主张
    // 独占端拉回期望尺寸、其余端同步到最终 window
    if (detachedSessionName) schedulePeerWindowSync(detachedHostId, detachedSessionName)
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
  async attach(attach: {
    hostId?: unknown
    sessionName?: unknown
    exclusive?: boolean
    passive?: boolean
    cols?: number
    rows?: number
  }) {
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
    const passive = this.shareTicket ? true : !!attach.passive
    if (
      STREAM_FANOUT_ENABLED &&
      this.sharedHub &&
      this.attachedSessionName === sessionName &&
      this.attachedHostId === hostId
    ) {
      // 已在同一 hub 上：exclusive/passive 原位切换（steal/refocus），不重建 PTY。
      // PTY 恒为 exclusive-capable，故尺寸主张与写准入只由 session 标志决定
      this.attachedExclusive = exclusive
      this.attachedPassive = passive
      this.attachVisibleOutputObserved = false
      if (exclusive && requestedCols > 0 && requestedRows > 0) {
        claimExclusiveOwnership(this)
        this.desiredCols = requestedCols
        this.desiredRows = requestedRows
        this.assertSeq = ++assertOrderSeq
        if (requestedCols !== this.sharedHub.cols || requestedRows !== this.sharedHub.rows) {
          this.sharedHub.resizePty(requestedCols, requestedRows)
          this.attachedCols = requestedCols
          this.attachedRows = requestedRows
        }
        schedulePeerWindowSync(hostId, sessionName)
      } else {
        this.attachedCols = this.sharedHub.cols
        this.attachedRows = this.sharedHub.rows
      }
      this.registerPeer()
      this.send({
        type: 'attached',
        sessionName,
        hostId,
        cols: this.attachedCols || requestedCols,
        rows: this.attachedRows || requestedRows,
        exclusive,
      })
      // 切换模式后需整帧恢复：refresh-client 重绘经共享 PTY 扇出全部订阅者
      // （单 tmux client 无法只刷一端），各端靠 output_resync 边界原子替换
      this.scheduleAttachRefresh(sessionName, this.attachSeq)
      console.log('Attach completed (hub reuse)', { sessionName, elapsedMs: Date.now() - attachStartedAt })
      return
    }
    if (
      this.ptyProcess &&
      !this.sharedHub &&
      this.attachedSessionName === sessionName &&
      this.attachedExclusive === exclusive &&
      this.attachedHostId === hostId
    ) {
      // 同 pty 复用：passive 只影响写操作准入，原位更新即可，无需重建附着
      this.attachedPassive = passive
      this.attachVisibleOutputObserved = false
      // 新 attach/复用首轮：完整清洗历史噪音，可见输出确认后回 light
      this.sanitizeMode = 'heavy'
      if (exclusive && requestedCols > 0 && requestedRows > 0) {
        // 复用即一次尺寸主张（refocus 回来要抢回 window）：更新期望并调度仲裁
        claimExclusiveOwnership(this)
        this.desiredCols = requestedCols
        this.desiredRows = requestedRows
        this.assertSeq = ++assertOrderSeq
        if (requestedCols !== this.attachedCols || requestedRows !== this.attachedRows) {
          this.ptyProcess.resize(requestedCols, requestedRows)
          this.attachedCols = requestedCols
          this.attachedRows = requestedRows
        }
        schedulePeerWindowSync(hostId, sessionName)
      }
      this.registerPeer()
      this.send({
        type: 'attached',
        sessionName,
        hostId,
        cols: this.attachedCols || requestedCols,
        rows: this.attachedRows || requestedRows,
        exclusive,
      })
      this.scheduleAttachRefresh(sessionName, this.attachSeq)
      console.log('Attach completed (reuse)', { sessionName, elapsedMs: Date.now() - attachStartedAt })
      return
    }
    this.cleanup()
    const sharedSize = exclusive ? null : await windowSizeQuery(hostId, sessionName)
    const cols = sharedSize?.cols || requestedCols
    const rows = sharedSize?.rows || requestedRows
    const seq = this.attachSeq
    if (STREAM_FANOUT_ENABLED) {
      const { hub, reused } = await acquireSharedTerminal({ hostId, sessionName, cols, rows })
      this.sharedHub = hub
      this.ptyProcess = hub.pty
      hub.subscribe(this)
      // 复用时以 hub 当前尺寸为权威（首订者/owner 可能已改过 window）
      const attachCols = reused ? hub.cols : cols
      const attachRows = reused ? hub.rows : rows
      this.attachedSessionName = sessionName
      this.attachedHostId = hostId
      this.attachedExclusive = exclusive
      this.attachedPassive = passive
      this.attachedCols = attachCols
      this.attachedRows = attachRows
      if (exclusive) {
        this.desiredCols = requestedCols > 0 ? requestedCols : attachCols
        this.desiredRows = requestedRows > 0 ? requestedRows : attachRows
        this.assertSeq = ++assertOrderSeq
        claimExclusiveOwnership(this)
        if (this.desiredCols !== hub.cols || this.desiredRows !== hub.rows) {
          hub.resizePty(this.desiredCols, this.desiredRows)
          this.attachedCols = this.desiredCols
          this.attachedRows = this.desiredRows
        }
      }
      this.registerPeer()
      if (this.cellOutputEnabled)
        this.cell.reset(attachCols, attachRows, this.cellOutputEnabled && this.binaryOutputEnabled)
      this.attachVisibleOutputObserved = false
      this.lastFrame = ''
      this.dedupDropLogCount = 0
      // fan-out 新 attach 首轮：hub 侧会 heavy；本端状态对齐边界语义
      this.sanitizeMode = 'heavy'
      if (!this.ptyProcess) throw new Error('Terminal attachment failed')
      this.send({ type: 'attached', sessionName, hostId, cols: this.attachedCols, rows: this.attachedRows, exclusive })
      if (exclusive) schedulePeerWindowSync(hostId, sessionName)
      // 新订者：refresh-client 补整帧。单 tmux client 的重绘字节进共享 PTY 后
      // 扇出全部订阅者——各端以 output_resync 边界原子替换（见 broadcastRedrawBoundary）
      this.scheduleAttachRefresh(sessionName, seq)
      console.log('Attach completed (fanout)', {
        sessionName,
        cols: this.attachedCols,
        rows: this.attachedRows,
        reused,
        elapsedMs: Date.now() - attachStartedAt,
      })
      return
    }
    const created = await createTerminalAttachment({ hostId, sessionName, cols, rows, exclusive })
    this.ptyProcess = created
    this.sharedHub = null
    this.attachedSessionName = sessionName
    this.attachedHostId = hostId
    this.attachedExclusive = exclusive
    this.attachedPassive = passive
    this.attachedCols = cols
    this.attachedRows = rows
    if (exclusive) {
      this.desiredCols = cols
      this.desiredRows = rows
      this.assertSeq = ++assertOrderSeq
      claimExclusiveOwnership(this)
    }
    this.registerPeer()
    if (this.cellOutputEnabled) this.cell.reset(cols, rows, this.cellOutputEnabled && this.binaryOutputEnabled)
    this.attachVisibleOutputObserved = false
    this.lastFrame = ''
    this.dedupDropLogCount = 0
    // 新 attach 首轮：heavy 完整清洗；首轮可见输出确认后回 light
    this.sanitizeMode = 'heavy'
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
        if (!this.attachVisibleOutputObserved && hasSubstantiveTerminalContent(filtered)) {
          this.attachVisibleOutputObserved = true
          // 首轮可见输出已到：边界清洗完成，后续 chunk 回 light 只剥 DA
          this.sanitizeMode = 'light'
        }
        this.queueOutput(filtered)
      }
      if (this.pendingResizeAck) {
        this.pendingResizeAck.outputObserved = true
        this.completeResizeAck()
      }
    })
    attachedProcess.onExit((exitCode) => {
      if (seq !== this.attachSeq) return
      this.handleProcessExit(exitCode)
    })
    this.send({ type: 'attached', sessionName, hostId, cols, rows, exclusive })
    if (exclusive) schedulePeerWindowSync(hostId, sessionName)
    this.scheduleAttachRefresh(sessionName, seq)
    console.log('Attach completed (new)', { sessionName, cols, rows, elapsedMs: Date.now() - attachStartedAt })
  }
  // 共享 hub 输出入口：sanitize 已在 hub 完成，这里只做本端 resync 丢弃/组帧/ACK
  onSharedOutput(filtered: string) {
    if (!this.attachedSessionName || !this.sharedHub) return
    if (this.outputResyncPending) {
      recordStreamMetric('droppedOutputChars', filtered.length)
      if (this.pendingResizeAck) {
        this.pendingResizeAck.outputObserved = true
        this.completeResizeAck()
      }
      return
    }
    if (filtered) {
      if (!this.attachVisibleOutputObserved && hasSubstantiveTerminalContent(filtered)) {
        this.attachVisibleOutputObserved = true
        // 首轮可见输出已到：边界清洗完成，后续 chunk 回 light 只剥 DA
        this.sanitizeMode = 'light'
      }
      this.queueOutput(filtered)
    }
    if (this.pendingResizeAck) {
      this.pendingResizeAck.outputObserved = true
      this.completeResizeAck()
    }
  }
  // 共享 hub 广播重绘边界（SharedTerminal.broadcastRedrawBoundary 回调）：
  // 别的订阅者触发的 refresh-client 重绘即将经 hub 扇出为本端普通 output。
  // 先冲掉积压保持「旧输出→边界→整屏新帧」帧序，再发 output_resync 边界
  // 并让前端原子替换；帧级去重/cell 基准一并复位，否则与旧帧全等的重绘
  // 会在清屏后被去重丢掉留下空屏。本端正在跑自己的 resync 时跳过——
  // 边界由其 resync 流程发，重复发会双清屏
  onSharedRedrawBoundary() {
    if (!this.attachedSessionName || !this.sharedHub || this.outputResyncPending) return
    this.flushOutput()
    const boundary = this.cellOutputEnabled ? RESYNC_RESET_SEQ.replace('\u001b[2J', '') : RESYNC_RESET_SEQ
    void this.sendTerminalOutput('output_resync', boundary, this.attachedSessionName, this.attachedHostId)
    this.lastFrame = ''
    if (this.cellOutputEnabled) this.cell.reset(this.attachedCols, this.attachedRows, this.binaryOutputEnabled)
    recordStreamMetric('sharedRedrawBoundaries')
  }
  onSharedExit(exitCode: number) {
    if (!this.attachedSessionName) return
    this.handleProcessExit(exitCode)
  }
  private handleProcessExit(exitCode: number) {
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
    this.unregisterPeer()
    this.sharedHub = null
    this.ptyProcess = null
    this.attachedSessionName = null
    this.attachedHostId = 'local'
    this.attachedExclusive = false
    this.attachedPassive = false
    this.attachedCols = 0
    this.attachedRows = 0
    this.lastExclusiveCols = 0
    this.lastExclusiveRows = 0
    this.lastExclusiveSeq = 0
    this.pendingResizeAck = null
    if (this.resizeAckTimer) {
      clearTimeout(this.resizeAckTimer)
      this.resizeAckTimer = null
    }
    this.clearAttachRefreshTimers()
    this.clearRedrawTimers()
    this.attachRefresh = null
    if (exitedSessionName) schedulePeerWindowSync(exitedHostId, exitedSessionName)
  }
  resize(cols: number, rows: number) {
    recordStreamMetric('resizeRequests')
    if (!this.ptyProcess) return
    // 被动/旁观端禁止改 client 尺寸，避免与 owner 的 window 主张打架
    if (this.attachedPassive) {
      this.send({
        type: 'resized',
        sessionName: this.attachedSessionName,
        hostId: this.attachedHostId,
        cols: this.attachedCols,
        rows: this.attachedRows,
      })
      return
    }
    // 共享 PTY 上非 owner 的 resize 只回当前尺寸：多端不同视口不得互抢 window
    if (this.sharedHub && !(this.attachedExclusive && this.isExclusiveOwner())) {
      this.send({
        type: 'resized',
        sessionName: this.attachedSessionName,
        hostId: this.attachedHostId,
        cols: this.attachedCols,
        rows: this.attachedRows,
      })
      return
    }
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
    if (this.sharedHub) this.sharedHub.resizePty(nextCols, nextRows)
    else this.ptyProcess.resize(nextCols, nextRows)
    this.attachedCols = nextCols
    this.attachedRows = nextRows
    if (this.attachedExclusive && this.isExclusiveOwner()) {
      // 独占 owner 的 resize 是一次尺寸主张：window 落定后把其它附着同步到新尺寸
      this.desiredCols = nextCols
      this.desiredRows = nextRows
      this.assertSeq = ++assertOrderSeq
      schedulePeerWindowSync(this.attachedHostId, this.attachedSessionName)
    }
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
  isExclusiveOwner() {
    if (this.exclusiveOwnerKey) return exclusiveOwners.get(this.exclusiveOwnerKey) === this
    // 本 session 已有正式 owner 时，无 key 的连接一律不是 owner（防降级后误主张）
    if (this.attachedSessionName) {
      const key = peerKey(this.attachedHostId, this.attachedSessionName)
      if (exclusiveOwners.has(key)) return exclusiveOwners.get(key) === this
    }
    // 未接入所有权表的旧路径/测试
    return this.attachedExclusive
  }
  // 被新的 exclusive claim 抢走所有权：立刻写降级，并摘掉可抢尺寸的 exclusive client。
  // 不在本函数内 reattach（会与 claim 竞态）；前端收到 exclusive-revoked 后以 shared+passive 重附着。
  demoteFromExclusive() {
    if (!this.attachedSessionName) return
    const hostId = this.attachedHostId
    const sessionName = this.attachedSessionName
    this.attachedExclusive = false
    this.attachedPassive = true
    // 降级前留存本次独占主张：本端仍是存活 peer，owner 断开且无人接管时
    // reconcile 用它把 window 拉回（desired 清零后这是唯一恢复依据）
    this.lastExclusiveCols = this.desiredCols || this.attachedCols
    this.lastExclusiveRows = this.desiredRows || this.attachedRows
    this.lastExclusiveSeq = this.assertSeq
    this.desiredCols = 0
    this.desiredRows = 0
    this.assertSeq = 0
    releaseExclusiveOwnership(this)
    this.send({ type: 'exclusive-revoked', hostId, sessionName })
    if (this.sharedHub) {
      // 共享 PTY 不随降级拆掉：本端转 passive 继续旁观，前端收到
      // exclusive-revoked 后以 shared+passive 原位重附着（hub reuse 分支）
      return
    }
    const proc = this.ptyProcess
    if (proc) {
      this.ptyProcess = null
      proc.kill()
    }
  }
  input(data: string) {
    recordStreamMetric('inputMessages')
    // 被动附着不得写 pty：键鼠输入（含滚轮→copy-mode）经 client stdin 直达
    // tmux server，是全局副作用，后台页必须完全无写能力
    if (this.ptyProcess && !this.attachedPassive) this.ptyProcess.write(data)
  }
  markAgentSeen(paneId: string) {
    if (!paneId.startsWith(this.attachedHostId + ':')) return
    if (!agentMonitor.markSeen(paneId)) markAgentPaneSeen(paneId)
  }
  /** Assign route for host+session; announce stream_route before first compact frame. */
  private ensureRoute(hostId: string, sessionName: string): number | null {
    if (!this.compactHeaderEnabled || !this.binaryOutputEnabled || !sessionName) return null
    const routeIdx = this.routes.assign(hostId, sessionName)
    if (routeIdx == null) return null
    if (!this.announcedRoutes.has(routeIdx)) {
      this.announcedRoutes.add(routeIdx)
      this.send({ type: 'stream_route', routeIdx, hostId, sessionName })
    }
    return routeIdx
  }
  applyCaps(data: { binaryOutput?: boolean; compressOutput?: string; cellOutput?: boolean; compactHeader?: boolean }) {
    this.binaryOutputEnabled = data.binaryOutput === true
    this.compressOutputEnabled = STREAM_COMPRESS_ENABLED && this.binaryOutputEnabled && data.compressOutput === 'gzip'
    this.cellOutputEnabled = STREAM_CELL_ENABLED && this.binaryOutputEnabled && data.cellOutput === true
    this.compactHeaderEnabled = STREAM_COMPACT_ENABLED && this.binaryOutputEnabled && data.compactHeader === true
    if (!this.compactHeaderEnabled) {
      this.routes.clear()
      this.announcedRoutes.clear()
    }
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
      compactHeader: this.compactHeaderEnabled,
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
