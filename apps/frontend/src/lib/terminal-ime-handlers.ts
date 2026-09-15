import { recordImeDebug } from './terminal-debug'
interface TerminalImeHandlersOptions {
  getHelperTextarea: () => HTMLTextAreaElement | null | undefined
  isComposing: () => boolean
  setComposing: (value: boolean) => void
  flushWriteBuffer: () => void
  syncHelperTextareaGeometry: () => void
}
export function createTerminalImeHandlers(options: TerminalImeHandlersOptions) {
  let pendingPostImeSyncTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePostImeSync = () => {
    if (pendingPostImeSyncTimer) clearTimeout(pendingPostImeSyncTimer)
    pendingPostImeSyncTimer = setTimeout(() => {
      pendingPostImeSyncTimer = null
      options.syncHelperTextareaGeometry()
    }, 300)
  }
  const handleCompositionStart = () => {
    options.setComposing(true)
    document.body.classList.add('ime-composing')
    if (pendingPostImeSyncTimer) {
      clearTimeout(pendingPostImeSyncTimer)
      pendingPostImeSyncTimer = null
    }
    recordImeDebug('helper-compositionstart', { value: options.getHelperTextarea()?.value || '' })
  }
  const handleCompositionEnd = () => {
    options.setComposing(false)
    document.body.classList.remove('ime-composing')
    recordImeDebug('helper-compositionend', { value: options.getHelperTextarea()?.value || '' })
    requestAnimationFrame(() => {
      options.flushWriteBuffer()
    })
    schedulePostImeSync()
  }
  const handleCompositionUpdate = (event: CompositionEvent) => {
    recordImeDebug('helper-compositionupdate', {
      data: event.data || '',
      value: options.getHelperTextarea()?.value || '',
    })
  }
  const handleFocus = () => {
    recordImeDebug('helper-focus', { value: options.getHelperTextarea()?.value || '' })
  }
  const handleBlur = () => {
    recordImeDebug('helper-blur', { value: options.getHelperTextarea()?.value || '' })
    if (!options.isComposing()) return
    options.setComposing(false)
    document.body.classList.remove('ime-composing')
    requestAnimationFrame(() => {
      options.flushWriteBuffer()
    })
    schedulePostImeSync()
  }
  const handleBeforeInput = (event: InputEvent) => {
    recordImeDebug('helper-beforeinput', {
      inputType: event.inputType || '',
      data: event.data || '',
      value: options.getHelperTextarea()?.value || '',
      composing: event.isComposing,
    })
  }
  const handleInput = (event: InputEvent) => {
    recordImeDebug('helper-input', {
      inputType: event.inputType || '',
      data: event.data || '',
      value: options.getHelperTextarea()?.value || '',
      composing: event.isComposing,
    })
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    recordImeDebug('helper-keydown', {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      keyCode: event.keyCode,
      isComposing: event.isComposing,
    })
  }
  const handleKeyUp = (event: KeyboardEvent) => {
    recordImeDebug('helper-keyup', {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      keyCode: event.keyCode,
      isComposing: event.isComposing,
    })
  }
  const dispose = () => {
    if (pendingPostImeSyncTimer) {
      clearTimeout(pendingPostImeSyncTimer)
      pendingPostImeSyncTimer = null
    }
  }
  return {
    handleCompositionStart,
    handleCompositionEnd,
    handleCompositionUpdate,
    handleFocus,
    handleBlur,
    handleBeforeInput,
    handleInput,
    handleKeyDown,
    handleKeyUp,
    dispose,
  }
}
