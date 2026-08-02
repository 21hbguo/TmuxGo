interface TerminalClipboardImeOptions {
  container: HTMLElement
  helperTextarea: HTMLTextAreaElement | null | undefined
  handleCopy: (event: ClipboardEvent) => void
  handleCompositionStart: () => void
  handleCompositionUpdate: (event: CompositionEvent) => void
  handleCompositionEnd: () => void
  handleFocus: () => void
  handleBlur: () => void
  handleBeforeInput: (event: InputEvent) => void
  handleInput: (event: InputEvent) => void
  handleKeyDown: (event: KeyboardEvent) => void
  handleKeyUp: (event: KeyboardEvent) => void
  handlePaste: EventListener
  handlePasteInput: EventListener
  armPointerSync: () => void
  handlePointerSync: (event?: MouseEvent | TouchEvent) => void
  clearPointerSync: () => void
  handleFocusTerminal: EventListener
}
export function createTerminalClipboardIme(options: TerminalClipboardImeOptions) {
  const { container, helperTextarea } = options
  const attach = () => {
    helperTextarea?.addEventListener('copy', options.handleCopy, true)
    container.addEventListener('copy', options.handleCopy, true)
    helperTextarea?.addEventListener('compositionstart', options.handleCompositionStart)
    helperTextarea?.addEventListener('compositionupdate', options.handleCompositionUpdate)
    helperTextarea?.addEventListener('compositionend', options.handleCompositionEnd)
    helperTextarea?.addEventListener('focus', options.handleFocus)
    helperTextarea?.addEventListener('blur', options.handleBlur)
    helperTextarea?.addEventListener('beforeinput', options.handleBeforeInput as EventListener, true)
    helperTextarea?.addEventListener('input', options.handleInput as EventListener, true)
    helperTextarea?.addEventListener('keydown', options.handleKeyDown, true)
    helperTextarea?.addEventListener('keyup', options.handleKeyUp, true)
    helperTextarea?.addEventListener('paste', options.handlePaste, true)
    container.addEventListener('paste', options.handlePaste, true)
    container.addEventListener('beforeinput', options.handlePasteInput, true)
    container.addEventListener('input', options.handlePasteInput, true)
    container.addEventListener('mousedown', options.armPointerSync)
    container.addEventListener('touchstart', options.armPointerSync, { passive: true })
    window.addEventListener('mouseup', options.handlePointerSync)
    window.addEventListener('touchend', options.handlePointerSync)
    window.addEventListener('touchcancel', options.clearPointerSync)
    window.addEventListener('pointercancel', options.clearPointerSync)
    window.addEventListener('blur', options.clearPointerSync)
    window.addEventListener('tmuxgo-focus-terminal', options.handleFocusTerminal)
  }
  const dispose = () => {
    helperTextarea?.removeEventListener('copy', options.handleCopy, true)
    container.removeEventListener('copy', options.handleCopy, true)
    helperTextarea?.removeEventListener('compositionstart', options.handleCompositionStart)
    helperTextarea?.removeEventListener('compositionupdate', options.handleCompositionUpdate)
    helperTextarea?.removeEventListener('compositionend', options.handleCompositionEnd)
    helperTextarea?.removeEventListener('focus', options.handleFocus)
    helperTextarea?.removeEventListener('blur', options.handleBlur)
    helperTextarea?.removeEventListener('beforeinput', options.handleBeforeInput as EventListener, true)
    helperTextarea?.removeEventListener('input', options.handleInput as EventListener, true)
    helperTextarea?.removeEventListener('keydown', options.handleKeyDown, true)
    helperTextarea?.removeEventListener('keyup', options.handleKeyUp, true)
    helperTextarea?.removeEventListener('paste', options.handlePaste, true)
    container.removeEventListener('paste', options.handlePaste, true)
    container.removeEventListener('beforeinput', options.handlePasteInput, true)
    container.removeEventListener('input', options.handlePasteInput, true)
    container.removeEventListener('mousedown', options.armPointerSync)
    container.removeEventListener('touchstart', options.armPointerSync)
    window.removeEventListener('mouseup', options.handlePointerSync)
    window.removeEventListener('touchend', options.handlePointerSync)
    window.removeEventListener('touchcancel', options.clearPointerSync)
    window.removeEventListener('pointercancel', options.clearPointerSync)
    window.removeEventListener('blur', options.clearPointerSync)
    window.removeEventListener('tmuxgo-focus-terminal', options.handleFocusTerminal)
  }
  return { attach, dispose }
}
