import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalClipboardIme } from './terminal-clipboard-ime'

function createOptions() {
  const handlers = {
    handleCopy: vi.fn(),
    handleCompositionStart: vi.fn(),
    handleCompositionUpdate: vi.fn(),
    handleCompositionEnd: vi.fn(),
    handleFocus: vi.fn(),
    handleBlur: vi.fn(),
    handleBeforeInput: vi.fn(),
    handleInput: vi.fn(),
    handleKeyDown: vi.fn(),
    handleKeyUp: vi.fn(),
    handlePaste: vi.fn(),
    handlePasteInput: vi.fn(),
    armPointerSync: vi.fn(),
    handlePointerSync: vi.fn(),
    clearPointerSync: vi.fn(),
    handleFocusTerminal: vi.fn(),
  }
  return handlers
}

describe('createTerminalClipboardIme helper textarea binding', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('attaches composition/key listeners to the given helper textarea', () => {
    const container = document.createElement('div')
    const helper = document.createElement('textarea')
    container.appendChild(helper)
    document.body.appendChild(container)
    const handlers = createOptions()
    const ime = createTerminalClipboardIme({ container, helperTextarea: helper, ...handlers })
    ime.attach()
    helper.dispatchEvent(new CompositionEvent('compositionstart'))
    helper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229 }))
    expect(handlers.handleCompositionStart).toHaveBeenCalledTimes(1)
    expect(handlers.handleKeyDown).toHaveBeenCalledTimes(1)
    ime.dispose()
  })

  it('stops listening on the old element and picks up a rebuilt one after re-attach', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const first = document.createElement('textarea')
    container.appendChild(first)
    const handlers = createOptions()
    const ime = createTerminalClipboardIme({ container, helperTextarea: first, ...handlers })
    ime.attach()
    // xterm 重建 helper textarea（open/renderer 回退）：旧元素监听必须整体迁走，
    // 否则组字标志、候选窗兜底、粘贴桥全部落在已脱离文档的元素上
    ime.dispose()
    first.remove()
    const second = document.createElement('textarea')
    container.appendChild(second)
    const rebound = createTerminalClipboardIme({ container, helperTextarea: second, ...handlers })
    rebound.attach()
    first.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(handlers.handleCompositionStart).not.toHaveBeenCalled()
    second.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(handlers.handleCompositionStart).toHaveBeenCalledTimes(1)
    rebound.dispose()
  })

  it('does not double-attach identity listeners on dispose/attach cycles', () => {
    const container = document.createElement('div')
    const helper = document.createElement('textarea')
    container.appendChild(helper)
    document.body.appendChild(container)
    const handlers = createOptions()
    const ime = createTerminalClipboardIme({ container, helperTextarea: helper, ...handlers })
    ime.attach()
    ime.dispose()
    ime.attach()
    helper.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(handlers.handleCompositionStart).toHaveBeenCalledTimes(1)
    ime.dispose()
  })
})
