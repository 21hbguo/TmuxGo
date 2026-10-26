import { recordImeDebug } from './terminal-debug'
import type { LayoutTerminal } from './terminal-layout'
// getWidth 是 IBufferLine 未公开的宽字符探测方法，真实 Terminal 上存在、mock 上可缺省——
// 用 Omit+自定义 buffer 覆盖公开类型，调用点保持 ?./try 防御
type FocusTerminal = Omit<LayoutTerminal, 'buffer'> & {
  buffer?: {
    active?: {
      cursorX?: number
      cursorY?: number
      getLine?: (y: number) => { length: number; getWidth?: (x: number) => number } | undefined
    }
  }
}
// 会持有 IME 输入上下文的元素：只有从这类元素上搬走焦点才需要先 blur
const IME_EDITABLE_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]'
const HELPER_TEXTAREA_SELECTOR = '.xterm-helper-textarea, textarea'
// 组字期焦点必然停在持有组字的 helper textarea 上；body 上的 ime-composing 是
// 跨组件共享信号，它单独存在而焦点不在 helper textarea 上时只能来自丢失的收尾
// 事件——焦点元素被移出文档时浏览器不派 blur，新建 session 的弹窗卸载/换帧都会
// 走到这里。这是纯读取判据，副作用（复位）由 terminal-ime-handlers 看门狗负责。
// 刻意不把弹窗输入框的组字算进来：那边组字时点终端，焦点本来就该搬进终端
export function isImeComposingActive() {
  if (typeof document === 'undefined' || !document.body.classList.contains('ime-composing')) return false
  const active = document.activeElement
  return active instanceof HTMLElement && active.matches('.xterm-helper-textarea')
}
interface TerminalFocusOptions {
  container: HTMLElement
  isMobile: boolean
  getTerminal: () => FocusTerminal | null | undefined
  focusKeyboard: () => void
  cancelTmuxCopyMode: () => void
}
export function createTerminalFocus(options: TerminalFocusOptions) {
  const { container, isMobile: isMobileDevice, getTerminal, focusKeyboard, cancelTmuxCopyMode } = options
  let helperTextareaComposing = false
  let helperTextarea: HTMLTextAreaElement | null | undefined = null
  const isDesktopImeComposing = () => helperTextareaComposing || document.body.classList.contains('ime-composing')
  const resolveHelperTextarea = () => {
    const input = helperTextarea || container.querySelector(HELPER_TEXTAREA_SELECTOR)
    return input instanceof HTMLTextAreaElement ? input : null
  }
  // 组字收尾信号（compositionend/blur）双丢后，标志位与 body class 会永久为真，
  // 使聚焦、输出缓冲全部短路。判据：组字中焦点必然在 helper textarea 上
  const isComposingStale = () => {
    if (!isDesktopImeComposing()) return false
    const input = resolveHelperTextarea()
    return !input || document.activeElement !== input
  }
  // 真正在组字（信号在且焦点还在组字元素上）才算 IME 占用：输出缓冲、聚焦闸门
  // 都用它，陈旧信号不再冻结终端，等看门狗复位
  const isDesktopImeComposingActive = () => isDesktopImeComposing() && !isComposingStale()
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
    const input = helperTextarea || container.querySelector(HELPER_TEXTAREA_SELECTOR)
    if (!(input instanceof HTMLTextAreaElement) || !terminal) return
    if (isDesktopImeComposingActive()) return
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
  const resetStaleComposing = () => {
    if (!isComposingStale()) return false
    helperTextareaComposing = false
    document.body.classList.remove('ime-composing')
    recordImeDebug('ime-composing-stale-reset', {
      active: document.activeElement instanceof HTMLElement ? document.activeElement.className : '',
    })
    return true
  }
  const focusTerminalInput = () => {
    const terminal = getTerminal()
    recordImeDebug('focus-terminal-input', {
      mobile: isMobileDevice,
      composing: helperTextareaComposing,
      stale: isComposingStale(),
    })
    if (isMobileDevice) {
      cancelTmuxCopyMode()
      focusKeyboard()
      return
    }
    resetStaleComposing()
    if (isDesktopImeComposingActive()) return
    const input = helperTextarea || container.querySelector(HELPER_TEXTAREA_SELECTOR)
    if (input instanceof HTMLTextAreaElement && document.activeElement === input) {
      syncHelperTextareaGeometry()
      clearTerminalBrowserSelection()
      return
    }
    // 把焦点从仍在组字的输入框直接搬进终端，会让 Chromium/X11 的 IME 上下文停在
    // "组字中"：此后该窗口不再派 compositionstart（候选窗再也不出，只能刷新页面）。
    // 先 blur 现行可编辑元素让 compositionend 落地；非可编辑元素不持有 IME 上下文，
    // 不碰它（blur 会误触其他组件的 onBlur 逻辑）
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== input && active.matches(IME_EDITABLE_SELECTOR)) {
      recordImeDebug('focus-blur-composing-input', { tag: active.tagName, className: active.className })
      active.blur()
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
    isDesktopImeComposingActive,
    isComposingStale,
    resetStaleComposing,
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
