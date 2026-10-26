import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalFocus, isImeComposingActive } from './terminal-focus'

function makeHarness() {
  const container = document.createElement('div')
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  container.appendChild(helper)
  document.body.appendChild(container)
  const terminal = {
    focus: vi.fn(() => helper.focus()),
    cols: 80,
    rows: 24,
    buffer: { active: { cursorX: 0, cursorY: 0 } },
  }
  const focusKeyboard = vi.fn()
  const focusApi = createTerminalFocus({
    container,
    isMobile: false,
    getTerminal: () => terminal as never,
    focusKeyboard,
    cancelTmuxCopyMode: vi.fn(),
  })
  focusApi.setHelperTextarea(helper)
  return {
    container,
    helper,
    terminal,
    focusApi,
    cleanup: () => {
      container.remove()
      document.body.classList.remove('ime-composing')
    },
  }
}

describe('createTerminalFocus ime gates', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        cb(0)
        return 1
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.classList.remove('ime-composing')
  })

  it('keeps focus on the helper textarea while a real composition is running', () => {
    const h = makeHarness()
    h.helper.focus()
    h.focusApi.setComposing(true)
    document.body.classList.add('ime-composing')
    const blur = vi.fn()
    h.helper.addEventListener('blur', blur)
    h.focusApi.focusTerminalInput()
    expect(h.focusApi.isDesktopImeComposingActive()).toBe(true)
    expect(blur).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(h.helper)
    h.cleanup()
  })

  it('heals a stuck composition flag and restores focus when the signal is stale', () => {
    const h = makeHarness()
    // 组字收尾事件双丢：信号还在，焦点早已不在组字元素上
    h.focusApi.setComposing(true)
    document.body.classList.add('ime-composing')
    const other = document.createElement('div')
    other.tabIndex = 0
    document.body.appendChild(other)
    other.focus()
    expect(h.focusApi.isComposingStale()).toBe(true)
    h.focusApi.focusTerminalInput()
    expect(h.focusApi.isComposing()).toBe(false)
    expect(document.body.classList.contains('ime-composing')).toBe(false)
    expect(document.activeElement).toBe(h.helper)
    other.remove()
    h.cleanup()
  })

  it('flushes output gating through the active check instead of a stale class', () => {
    const h = makeHarness()
    document.body.classList.add('ime-composing')
    const other = document.createElement('div')
    other.tabIndex = 0
    document.body.appendChild(other)
    other.focus()
    // 陈旧信号不再冻结输出（否则终端一直不出字，只能刷新）
    expect(h.focusApi.isDesktopImeComposing()).toBe(true)
    expect(h.focusApi.isDesktopImeComposingActive()).toBe(false)
    // 真正组字时仍然保持闸门
    h.helper.focus()
    expect(h.focusApi.isDesktopImeComposingActive()).toBe(true)
    other.remove()
    h.cleanup()
  })

  it('blurs a foreign editable element before moving focus into the terminal', () => {
    const h = makeHarness()
    const dialogInput = document.createElement('input')
    document.body.appendChild(dialogInput)
    dialogInput.focus()
    const order: string[] = []
    dialogInput.addEventListener('blur', () => order.push('blur-dialog'))
    h.helper.addEventListener('focus', () => order.push('focus-terminal'))
    h.focusApi.focusTerminalInput()
    // 先把 IME 上下文从弹窗输入框收尾，再聚焦终端：直接搬焦点会把 Chromium 的
    // IME 上下文停在组字中，之后该窗口再也不出候选窗
    expect(order).toEqual(['blur-dialog', 'focus-terminal'])
    expect(document.activeElement).toBe(h.helper)
    dialogInput.remove()
    h.cleanup()
  })

  it('isImeComposingActive only trusts compositions hosted by the helper textarea', () => {
    const h = makeHarness()
    const dialogInput = document.createElement('input')
    document.body.appendChild(dialogInput)
    document.body.classList.add('ime-composing')
    dialogInput.focus()
    expect(isImeComposingActive()).toBe(false)
    h.helper.focus()
    expect(isImeComposingActive()).toBe(true)
    document.body.classList.remove('ime-composing')
    expect(isImeComposingActive()).toBe(false)
    dialogInput.remove()
    h.cleanup()
  })
})
