import { recordImeDebug } from './terminal-debug'
interface TerminalImeHandlersOptions {
  getHelperTextarea: () => HTMLTextAreaElement | null | undefined
  isComposing: () => boolean
  setComposing: (value: boolean) => void
  flushWriteBuffer: () => void
  syncHelperTextareaGeometry: () => void
}
// 组字态是全局信号（body.ime-composing + focus 侧标志位），唯一的复位时机是
// compositionend/blur。而焦点元素被移出文档时浏览器不派 blur、IME 上下文被掰断
// 时也不派 compositionend——两者同时丢失就把信号永久钉死：聚焦、输出缓冲全部
// 短路，用户只能刷新整个 app。看门狗按"组字中焦点必在 helper textarea 上"判陈旧
const COMPOSITION_HEALTH_CHECK_MS = 400
// 超长组字兜底：单次组字不该超过这个时长；中途若真有 update 会刷新计时
const COMPOSITION_MAX_MS = 60_000
// 空闲判据：组字中每次按键都有 compositionupdate，长时间无事件说明收尾丢了。
// 复位是安全的——真在组字时下一键的 update 会把状态补回来（handleCompositionUpdate）
const COMPOSITION_IDLE_MS = 4_000
export function createTerminalImeHandlers(options: TerminalImeHandlersOptions) {
  let pendingPostImeSyncTimer: ReturnType<typeof setTimeout> | null = null
  let compositionHealthTimer: ReturnType<typeof setTimeout> | null = null
  let composingSince = 0
  let lastCompositionEventAt = 0
  const schedulePostImeSync = () => {
    if (pendingPostImeSyncTimer) clearTimeout(pendingPostImeSyncTimer)
    pendingPostImeSyncTimer = setTimeout(() => {
      pendingPostImeSyncTimer = null
      options.syncHelperTextareaGeometry()
    }, 300)
  }
  const clearCompositionHealthCheck = () => {
    if (!compositionHealthTimer) return
    clearTimeout(compositionHealthTimer)
    compositionHealthTimer = null
  }
  const armCompositionHealthCheck = () => {
    clearCompositionHealthCheck()
    compositionHealthTimer = setTimeout(checkCompositionHealth, COMPOSITION_HEALTH_CHECK_MS)
  }
  const resetComposition = (reason: string) => {
    const wasComposing = options.isComposing() || document.body.classList.contains('ime-composing')
    clearCompositionHealthCheck()
    if (!wasComposing) return false
    options.setComposing(false)
    document.body.classList.remove('ime-composing')
    composingSince = 0
    lastCompositionEventAt = 0
    recordImeDebug('helper-composition-reset', {
      reason,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.className : '',
    })
    requestAnimationFrame(() => {
      options.flushWriteBuffer()
    })
    schedulePostImeSync()
    return true
  }
  const checkCompositionHealth = () => {
    compositionHealthTimer = null
    if (!options.isComposing() && !document.body.classList.contains('ime-composing')) return
    const now = Date.now()
    const helper = options.getHelperTextarea()
    // 焦点离开组字元素 = 收尾事件丢了（含 helper textarea 被 xterm 重建的情形）
    const focusLost = !helper || document.activeElement !== helper
    if (focusLost) {
      resetComposition('focus-lost')
      return
    }
    if (now - composingSince > COMPOSITION_MAX_MS || now - lastCompositionEventAt > COMPOSITION_IDLE_MS) {
      resetComposition('idle-timeout')
      return
    }
    armCompositionHealthCheck()
  }
  const handleCompositionStart = () => {
    options.setComposing(true)
    document.body.classList.add('ime-composing')
    if (pendingPostImeSyncTimer) {
      clearTimeout(pendingPostImeSyncTimer)
      pendingPostImeSyncTimer = null
    }
    composingSince = Date.now()
    lastCompositionEventAt = composingSince
    armCompositionHealthCheck()
    recordImeDebug('helper-compositionstart', { value: options.getHelperTextarea()?.value || '' })
  }
  const handleCompositionEnd = () => {
    resetComposition('compositionend')
    recordImeDebug('helper-compositionend', { value: options.getHelperTextarea()?.value || '' })
  }
  const handleCompositionUpdate = (event: CompositionEvent) => {
    // 复位后又收到 update = 组字其实还在继续（空闲误判/信号被清），补回状态
    if (!options.isComposing()) {
      options.setComposing(true)
      document.body.classList.add('ime-composing')
      composingSince = Date.now()
      armCompositionHealthCheck()
      recordImeDebug('helper-composition-recovered', { data: event.data || '' })
    }
    lastCompositionEventAt = Date.now()
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
    resetComposition('blur')
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
    clearCompositionHealthCheck()
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
    resetComposition,
    isComposingWatchActive: () => compositionHealthTimer !== null,
    dispose,
  }
}
