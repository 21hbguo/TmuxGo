import type { PaneResizeTarget } from './terminal-pane-interactions'
interface TerminalPaneResizeOptions {
  container: HTMLElement
  guide: HTMLElement | null
  getTerminal: () => any
  getMouseCell: (event: MouseEvent) => { x: number; y: number } | null
  getPaneResizeTarget: (event: MouseEvent) => PaneResizeTarget | null
  resizePane: (paneId: string, size: { cols?: number; rows?: number }) => Promise<unknown>
  loadSessionSnapshot: () => Promise<unknown>
  showResizeMask: () => number
  revealResizeMask: (generation: number) => void
  clearSelection: () => void
  clearCopySelectionTimer: () => void
  clearPointerSync: () => void
  dispatchLayoutChange: () => void
}
export function createTerminalPaneResizeController(options: TerminalPaneResizeOptions) {
  let drag: (PaneResizeTarget & { pendingSize: number; sentSize: number; maskGeneration: number }) | null = null
  let hoverThrottle = 0
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
    if (!current.pendingSize || current.pendingSize === current.sentSize) {
      drag = null
      hideGuide()
      options.revealResizeMask(current.maskGeneration)
      options.container.style.cursor = ''
      removeWindowListeners()
      return
    }
    const size = current.pendingSize
    current.sentSize = size
    void options.resizePane(current.paneId, current.axis === 'x' ? { cols: size } : { rows: size }).catch(() => null).then(() => {
      void options.loadSessionSnapshot().catch(() => null)
      options.dispatchLayoutChange()
      options.revealResizeMask(current.maskGeneration)
    })
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
    drag = { ...target, pendingSize: target.startSize, sentSize: target.startSize, maskGeneration: options.showResizeMask() }
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
    options.container.style.cursor = target ? target.axis === 'x' ? 'col-resize' : 'row-resize' : ''
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
