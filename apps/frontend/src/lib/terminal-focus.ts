import { recordImeDebug } from './terminal-debug'
interface TerminalFocusOptions {
  container: HTMLElement
  isMobile: boolean
  getTerminal: () => any
  focusKeyboard: () => void
  cancelTmuxCopyMode: () => void
}
export function createTerminalFocus(options: TerminalFocusOptions) {
  const { container, isMobile: isMobileDevice, getTerminal, focusKeyboard, cancelTmuxCopyMode } = options
  let helperTextareaComposing = false
  let helperTextarea: HTMLTextAreaElement | null | undefined = null
  const isDesktopImeComposing = () => helperTextareaComposing || document.body.classList.contains('ime-composing')
  const clearTerminalBrowserSelection = () => {
    const selection = window.getSelection?.()
    if (!selection) return
    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode
    if ((anchorNode && container.contains(anchorNode)) || (focusNode && container.contains(focusNode)))
      selection.removeAllRanges()
  }
  const syncHelperTextareaGeometry = () => {
    const terminal = getTerminal()
    const input = helperTextarea || container.querySelector('.xterm-helper-textarea, textarea')
    if (!(input instanceof HTMLTextAreaElement) || !terminal) return
    if (isDesktopImeComposing()) return
    const activeBuffer = terminal.buffer?.active
    const cursorXRaw = Number(activeBuffer?.cursorX)
    const cursorYRaw = Number(activeBuffer?.cursorY)
    const cellWidth = Number(terminal._core?._renderService?.dimensions?.css?.cell?.width)
    const cellHeight = Number(terminal._core?._renderService?.dimensions?.css?.cell?.height)
    if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return
    const maxX = Math.max(0, (Number(terminal.cols) || 1) - 1)
    const maxY = Math.max(0, (Number(terminal.rows) || 1) - 1)
    const cursorX = Math.max(0, Math.min(maxX, Number.isFinite(cursorXRaw) ? cursorXRaw : 0))
    const cursorY = Math.max(0, Math.min(maxY, Number.isFinite(cursorYRaw) ? cursorYRaw : 0))
    let charWidth = 1
    try {
      const line = activeBuffer?.getLine?.(cursorY)
      const width = Number(line?.getWidth?.(cursorX))
      if (Number.isFinite(width) && width > 0) charWidth = width
    } catch {}
    input.style.left = `${cursorX * cellWidth}px`
    input.style.top = `${cursorY * cellHeight}px`
    input.style.width = `${cellWidth * charWidth}px`
    input.style.height = `${cellHeight}px`
    input.style.lineHeight = `${cellHeight}px`
    input.style.zIndex = '-5'
  }
  const focusTerminalInput = () => {
    const terminal = getTerminal()
    recordImeDebug('focus-terminal-input', { mobile: isMobileDevice, composing: helperTextareaComposing })
    if (isMobileDevice) {
      cancelTmuxCopyMode()
      focusKeyboard()
      return
    }
    if (isDesktopImeComposing()) return
    const input = helperTextarea || container.querySelector('.xterm-helper-textarea, textarea')
    if (input instanceof HTMLTextAreaElement && document.activeElement === input) {
      syncHelperTextareaGeometry()
      clearTerminalBrowserSelection()
      return
    }
    terminal?.focus?.()
    if (input instanceof HTMLTextAreaElement) {
      if (document.activeElement !== input) input.focus({ preventScroll: true })
      syncHelperTextareaGeometry()
      requestAnimationFrame(syncHelperTextareaGeometry)
    }
    clearTerminalBrowserSelection()
    requestAnimationFrame(clearTerminalBrowserSelection)
  }
  return {
    isDesktopImeComposing,
    clearTerminalBrowserSelection,
    syncHelperTextareaGeometry,
    focusTerminalInput,
    isComposing: () => helperTextareaComposing,
    setComposing: (value: boolean) => {
      helperTextareaComposing = value
    },
    setHelperTextarea: (value: HTMLTextAreaElement | null | undefined) => {
      helperTextarea = value
    },
  }
}
