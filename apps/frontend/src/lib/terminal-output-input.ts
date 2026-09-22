import { applyCellToXterm } from './terminal-grid/apply-cell'
interface TerminalOutputInputOptions {
  getTerminal: () => any
  pushOutput: (data: string) => void
  disposeOutput: () => void
  isDesktopImeComposing: () => boolean
  isMobile: boolean
  getHostId: () => string
  getSessionName: () => string | undefined
  onRawOutput?: (raw: string) => void
  onOutput?: () => void
  // 切换 flush 的原子写通道：整帧一笔进 xterm，绕过 scheduler 的 32KB 切块
  writeAtomic?: (data: string) => void
  controlCarryRef: { current: string }
}
type OutputPayload = {
  data: string
  sessionName?: string | null
  hostId?: string | null
  resync?: boolean
  cell?: { kind: 'snapshot'; snapshot: any } | { kind: 'diff'; diff: any }
}
const SELECTION_HOLD_MAX_BUFFER = 1024 * 1024
const SELECTION_HOLD_CHECK_MS = 800
// A drag-select normally produces a selection within a few frames; if the
// pointer stays "down" this long with no selection the sync state is stale
// (e.g. mouseup lost outside the window) and must no longer block liveness.
const POINTER_SYNC_STALE_MS = 1500
export function createTerminalOutputInput(options: TerminalOutputInputOptions) {
  let writeBuffer = ''
  let writePending = false
  let pointerSyncActive = false
  let pointerSyncArmedAt = 0
  let selectionHold = false
  let switchHold = false
  let lastSelectionCheck = 0
  let outputSinceLastAttach = false
  const releaseSelection = () => {
    if (!selectionHold) return
    selectionHold = false
    flushWriteBuffer()
  }
  const flushWriteBuffer = () => {
    // switchHold 期间只允许 flushSwitchHold 原子写回，普通 flush 会破坏"旧帧→新帧"的单笔写入
    if (selectionHold || switchHold) return
    const terminal = options.getTerminal()
    if (!writeBuffer || !terminal?.write) {
      writeBuffer = ''
      writePending = false
      return
    }
    const data = writeBuffer
    writeBuffer = ''
    writePending = false
    options.pushOutput(data)
  }
  const handleOutput = (event: Event | string | OutputPayload) => {
    const payload =
      typeof event === 'string'
        ? { data: event, sessionName: null, hostId: null }
        : event instanceof Event
          ? { data: String((event as CustomEvent).detail || ''), sessionName: null, hostId: null }
          : event
    if (payload.hostId && payload.hostId !== options.getHostId()) return
    const currentSessionName = options.getSessionName()
    if (payload.sessionName && payload.sessionName !== currentSessionName) return
    const raw = payload.data
    const terminal = options.getTerminal()
    if (payload.resync) options.disposeOutput()
    // cell 帧优先直写 xterm buffer（失败才退回 ANSI write 管道）
    if (payload.cell) {
      if (!terminal) return
      if (applyCellToXterm(terminal, payload.cell as any)) {
        options.onRawOutput?.(raw || '')
        outputSinceLastAttach = true
        options.controlCarryRef.current = ''
        options.onOutput?.()
        return
      }
    }
    if (!raw || !terminal?.write) return
    options.onRawOutput?.(raw)
    outputSinceLastAttach = true
    options.controlCarryRef.current = ''
    // Session 切换期间攒流：新 session 的 attach 重绘先整帧缓存，
    // 由调用方一次性写回，避免"清屏→逐行重绘"的中间态闪烁。
    if (switchHold) {
      if (payload.resync) writeBuffer = raw
      else writeBuffer += raw
      options.onOutput?.()
      return
    }
    // Hold terminal paints while desktop IME is composing so candidate window stays put.
    // 默认路径（无 hold）不经 writeBuffer，直接 pushOutput 直达 xterm——
    // 与 gateway 4ms 攒包叠加时二次缓冲会放大输入回显延迟。
    if (pointerSyncActive || selectionHold || (!options.isMobile && options.isDesktopImeComposing())) {
      if (payload.resync) writeBuffer = raw
      else writeBuffer += raw
      if (selectionHold) {
        if (writeBuffer.length > SELECTION_HOLD_MAX_BUFFER) releaseSelection()
        else {
          const now = Date.now()
          if (now - lastSelectionCheck >= SELECTION_HOLD_CHECK_MS) {
            lastSelectionCheck = now
            const pointerStale = pointerSyncActive && now - pointerSyncArmedAt > POINTER_SYNC_STALE_MS
            if ((!pointerSyncActive || pointerStale) && !terminal.getSelection?.()) releaseSelection()
          }
        }
        return
      }
      if (pointerSyncActive && !writePending && !options.isDesktopImeComposing()) {
        writePending = true
        requestAnimationFrame(flushWriteBuffer)
      }
      return
    }
    options.pushOutput(raw)
  }
  const holdSelection = () => {
    selectionHold = true
  }
  const beginSwitchHold = () => {
    switchHold = true
    writeBuffer = ''
    writePending = false
  }
  // 把切换期间攒下的输出一次性写回；prepend 用于在同一笔写入里
  // 先清滚动区/屏幕（\x1b[3J\x1b[2J），保证"旧帧→新帧"原子替换。
  const flushSwitchHold = (prepend = '') => {
    switchHold = false
    const data = writeBuffer
    writeBuffer = ''
    writePending = false
    const payload = prepend + data
    if (!payload) return
    // 整帧必须一笔进 xterm：走 scheduler 会被按 32KB 切块，
    // 拆开的"清屏序列+半帧"会先上屏一次，造成二次重绘
    if (options.writeAtomic && options.getTerminal()?.write) options.writeAtomic(payload)
    else options.pushOutput(payload)
  }
  const hasSwitchBuffered = () => writeBuffer.length > 0
  const isSwitchHolding = () => switchHold
  const armPointerSync = () => {
    pointerSyncActive = true
    pointerSyncArmedAt = Date.now()
  }
  const disarmPointerSync = () => {
    pointerSyncActive = false
  }
  const clearPointerSync = () => {
    pointerSyncActive = false
    // Pointer was cancelled/lost: drop the selection hold unless real text
    // is still selected, otherwise output would freeze for a quiet pane.
    if (selectionHold && !options.getTerminal()?.getSelection?.()) releaseSelection()
    flushWriteBuffer()
  }
  return {
    handleOutput,
    flushWriteBuffer,
    holdSelection,
    releaseSelection,
    beginSwitchHold,
    flushSwitchHold,
    hasSwitchBuffered,
    isSwitchHolding,
    isSelectionHoldActive: () => selectionHold,
    armPointerSync,
    disarmPointerSync,
    clearPointerSync,
    isPointerSyncActive: () => pointerSyncActive,
    // 测试/诊断：writeBuffer 是否仍有未 flush 内容（默认直写路径应恒为 false）
    hasWriteBuffered: () => writeBuffer.length > 0,
    consumeAttachOutputFlag: () => {
      const had = outputSinceLastAttach
      outputSinceLastAttach = false
      return had
    },
  }
}
