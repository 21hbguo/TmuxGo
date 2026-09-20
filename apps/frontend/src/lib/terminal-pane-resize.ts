import type { PaneResizeTarget } from './terminal-pane-interactions'
import { emitStreamEvent, STREAM_EVENT } from './stream-events'
interface TerminalPaneResizeOptions {
  container: HTMLElement
  guide: HTMLElement | null
  getTerminal: () => any
  getMouseCell: (event: MouseEvent) => { x: number; y: number } | null
  getPaneResizeTarget: (event: MouseEvent) => PaneResizeTarget | null
  resizePane: (paneId: string, size: { cols?: number; rows?: number }) => Promise<unknown>
  loadSessionSnapshot: () => Promise<unknown>
  clearSelection: () => void
  clearCopySelectionTimer: () => void
  clearPointerSync: () => void
  dispatchLayoutChange: () => void
}
export function createTerminalPaneResizeController(options: TerminalPaneResizeOptions) {
  // 短合并窗：同一 pane+axis 连续快拖只在静止后提交最后目标（latest-wins），
  // 与 PaneGrid 远端 WS 合并同语义；已发出的请求不可撤回，不同 pane/axis
  // 各自独立 pending 不得互相覆盖
  const RESIZE_COMMIT_MS = 80
  let drag: (PaneResizeTarget & { pendingSize: number; sentSize: number }) | null = null
  let hoverThrottle = 0
  let pendingCommit: { paneId: string; axis: 'x' | 'y'; size: number; timer: ReturnType<typeof setTimeout> } | null =
    null
  const flushCommit = () => {
    const pending = pendingCommit
    pendingCommit = null
    if (!pending) return
    void options
      .resizePane(pending.paneId, pending.axis === 'x' ? { cols: pending.size } : { rows: pending.size })
      .catch(() => null)
      .then(() => {
        void options.loadSessionSnapshot().catch(() => null)
        options.dispatchLayoutChange()
      })
  }
  const queueCommit = (paneId: string, axis: 'x' | 'y', size: number) => {
    if (pendingCommit && (pendingCommit.paneId !== paneId || pendingCommit.axis !== axis)) flushCommit()
    if (pendingCommit) clearTimeout(pendingCommit.timer)
    pendingCommit = { paneId, axis, size, timer: setTimeout(flushCommit, RESIZE_COMMIT_MS) }
  }
  const dropPendingCommit = (paneId: string, axis: 'x' | 'y') => {
    // 新一次拖拽开始：同 pane+axis 的待提交中间尺寸已被本手势取代，丢弃；
    // 不丢会中途发出一个马上过期的尺寸
    if (pendingCommit?.paneId === paneId && pendingCommit.axis === axis) {
      clearTimeout(pendingCommit.timer)
      pendingCommit = null
    }
  }
  const hideGuide = () => {
    if (options.guide) options.guide.style.display = 'none'
  }
  const syncGuide = () => {
    const terminal = options.getTerminal()
    const current = drag
    const guide = options.guide
    const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
    if (!current || !guide || !screen || !terminal?.cols || !terminal?.rows) return
    const screenRect = screen.getBoundingClientRect()
    const containerRect = options.container.getBoundingClientRect()
    const cellWidth = screenRect.width / terminal.cols
    const cellHeight = screenRect.height / terminal.rows
    if (!cellWidth || !cellHeight) return
    guide.style.display = 'block'
    if (current.axis === 'x') {
      guide.style.left = `${screenRect.left - containerRect.left + (current.paneStart + current.pendingSize) * cellWidth - 1}px`
      guide.style.top = `${screenRect.top - containerRect.top + current.crossStart * cellHeight}px`
      guide.style.width = '2px'
      guide.style.height = `${current.crossSize * cellHeight}px`
    } else {
      guide.style.left = `${screenRect.left - containerRect.left + current.crossStart * cellWidth}px`
      guide.style.top = `${screenRect.top - containerRect.top + (current.paneStart + current.pendingSize) * cellHeight - 1}px`
      guide.style.width = `${current.crossSize * cellWidth}px`
      guide.style.height = '2px'
    }
  }
  const updateDrag = (event: MouseEvent) => {
    if (!drag) return
    const cell = options.getMouseCell(event)
    if (!cell) return
    const delta = (drag.axis === 'x' ? cell.x : cell.y) - drag.startCell
    const nextSize = Math.max(4, drag.startSize + delta)
    if (nextSize === drag.pendingSize) return
    drag.pendingSize = nextSize
    syncGuide()
  }
  const handleMove = (event: MouseEvent) => {
    if (!drag) return
    event.preventDefault()
    updateDrag(event)
  }
  const removeWindowListeners = () => {
    window.removeEventListener('mousemove', handleMove)
    window.removeEventListener('mouseup', endDrag)
    window.removeEventListener('blur', endDrag)
  }
  const endDrag = () => {
    const current = drag
    if (!current) return
    // pane 分隔条拖动只允许本地 guide 跟手：terminal 级 mask 会盖住所有 pane 造成
    // 整屏白闪，scope 错误——松手后由最终一次 resizePane + snapshot 重绘恢复
    emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
    if (!current.pendingSize || current.pendingSize === current.sentSize) {
      drag = null
      hideGuide()
      options.container.style.cursor = ''
      removeWindowListeners()
      return
    }
    const size = current.pendingSize
    current.sentSize = size
    queueCommit(current.paneId, current.axis, size)
    drag = null
    hideGuide()
    options.container.style.cursor = ''
    removeWindowListeners()
  }
  const handleStart = (event: MouseEvent) => {
    const target = options.getPaneResizeTarget(event)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    options.clearPointerSync()
    options.clearCopySelectionTimer()
    options.clearSelection()
    dropPendingCommit(target.paneId, target.axis)
    drag = { ...target, pendingSize: target.startSize, sentSize: target.startSize }
    emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
    syncGuide()
    options.container.style.cursor = target.axis === 'x' ? 'col-resize' : 'row-resize'
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', endDrag)
    window.addEventListener('blur', endDrag)
  }
  const handleHover = (event: MouseEvent) => {
    if (drag) return
    const now = performance.now()
    if (now - hoverThrottle < 50) return
    hoverThrottle = now
    const target = options.getPaneResizeTarget(event)
    options.container.style.cursor = target ? (target.axis === 'x' ? 'col-resize' : 'row-resize') : ''
  }
  const clearHover = () => {
    if (!drag) options.container.style.cursor = ''
  }
  const attach = () => {
    options.container.addEventListener('mousedown', handleStart, true)
    options.container.addEventListener('mousemove', handleHover)
    options.container.addEventListener('mouseleave', clearHover)
  }
  const dispose = () => {
    // 卸载/销毁时若仍在拖拽必须补 end：PaneGrid 的 burst 抑制否则永久卡住
    if (drag) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
    // 待提交尺寸立即发出而不是迟发：手势已合法完成，销毁不应丢用户意图
    flushCommit()
    drag = null
    removeWindowListeners()
    options.container.removeEventListener('mousedown', handleStart, true)
    options.container.removeEventListener('mousemove', handleHover)
    options.container.removeEventListener('mouseleave', clearHover)
    options.container.style.cursor = ''
    hideGuide()
  }
  return { attach, dispose, hide: hideGuide }
}
