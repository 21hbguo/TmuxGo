import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef } from 'react'
import { useMobileKeyboard } from './useMobileKeyboard'

let api: { focusKeyboard?: () => void; textarea?: HTMLTextAreaElement | null; isMobile?: boolean } = {}
let viewportTarget: EventTarget
let sendInputMock:(data: string) => void

function Harness() {
  const terminalRef = useRef<HTMLDivElement>(null)
  const { textareaRef, focusKeyboard, isMobile } = useMobileKeyboard(sendInputMock, terminalRef)
  useEffect(() => {
    api = { focusKeyboard, textarea: textareaRef.current, isMobile }
  }, [focusKeyboard, isMobile, textareaRef])
  return <div ref={terminalRef}><textarea ref={textareaRef} /></div>
}

describe('useMobileKeyboard', () => {
  beforeEach(() => {
    api = {}
    sendInputMock = vi.fn()
    viewportTarget = new EventTarget()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 390,
        height: 800,
        addEventListener: (type: string, listener: EventListener) => viewportTarget.addEventListener(type, listener),
        removeEventListener: (type: string, listener: EventListener) => viewportTarget.removeEventListener(type, listener),
        dispatchEvent: (event: Event) => viewportTarget.dispatchEvent(event),
      },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.classList.remove('keyboard-open')
    document.documentElement.style.removeProperty('--mobile-keyboard-inset')
    vi.unstubAllGlobals()
  })
  it('does not reopen after a normal mobile keyboard blur', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.focusKeyboard).toBeTruthy())
    api.focusKeyboard?.()
    expect(document.body.classList.contains('keyboard-open')).toBe(false)
    ;(window.visualViewport as any).height = 520
    window.visualViewport?.dispatchEvent(new Event('resize'))
    expect(document.body.classList.contains('keyboard-open')).toBe(true)
    api.textarea?.blur()
    await waitFor(() => expect(document.body.classList.contains('keyboard-open')).toBe(false))
    expect(document.activeElement).not.toBe(api.textarea)
  })
  it('keeps focus only for shortcut bar interactions', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.focusKeyboard).toBeTruthy())
    const button = document.createElement('button')
    button.setAttribute('data-keep-mobile-keyboard', 'true')
    document.body.appendChild(button)
    api.focusKeyboard?.()
    ;(window.visualViewport as any).height = 520
    window.visualViewport?.dispatchEvent(new Event('resize'))
    fireEvent.pointerDown(button)
    api.textarea?.blur()
    await waitFor(() => expect(document.body.classList.contains('keyboard-open')).toBe(true))
    expect(document.activeElement).toBe(api.textarea)
    button.remove()
  })
  it('does not close during keep-alive viewport bounce from shortcut interactions', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.focusKeyboard).toBeTruthy())
    const button = document.createElement('button')
    button.setAttribute('data-keep-mobile-keyboard', 'true')
    document.body.appendChild(button)
    api.focusKeyboard?.()
    ;(window.visualViewport as any).height = 520
    window.visualViewport?.dispatchEvent(new Event('resize'))
    expect(document.body.classList.contains('keyboard-open')).toBe(true)
    fireEvent.pointerDown(button)
    ;(window.visualViewport as any).height = 800
    window.visualViewport?.dispatchEvent(new Event('resize'))
    expect(document.body.classList.contains('keyboard-open')).toBe(true)
    button.remove()
  })
  it('closes stale keyboard state after viewport recovers without blur event', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.focusKeyboard).toBeTruthy())
    api.focusKeyboard?.()
    ;(window.visualViewport as any).height = 520
    window.visualViewport?.dispatchEvent(new Event('resize'))
    expect(document.body.classList.contains('keyboard-open')).toBe(true)
    ;(window.visualViewport as any).height = 760
    await waitFor(() => expect(document.body.classList.contains('keyboard-open')).toBe(false), { timeout: 1200 })
    expect(document.activeElement).not.toBe(api.textarea)
  })
  it('does not emit keyboard close events for closed viewport resize', async () => {
    const events: Array<{ open?: boolean; inset?: number }> = []
    window.addEventListener('mobile-keyboard-change', ((event: Event) => events.push(((event as CustomEvent).detail || {}))) as EventListener)
    render(<Harness />)
    await waitFor(() => expect(api.focusKeyboard).toBeTruthy())
    window.visualViewport?.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual([])
  })
  it('keeps composition text until compositionend', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.textarea).toBeTruthy())
    const textarea = api.textarea as HTMLTextAreaElement
    act(() => {
      fireEvent.compositionStart(textarea)
      textarea.value = 'zhong'
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'zhong' }))
    })
    expect(textarea.value).toBe('zhong')
    expect(sendInputMock).not.toHaveBeenCalled()
    act(() => {
      textarea.value = '中'
      fireEvent.compositionEnd(textarea)
    })
    expect(sendInputMock).toHaveBeenCalledWith('中')
    expect(textarea.value).toBe('\u200b\u200b')
  })
  it('does not send enter while ime confirmation keydown is still composing', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.textarea).toBeTruthy())
    const textarea = api.textarea as HTMLTextAreaElement
    act(() => {
      fireEvent.compositionStart(textarea)
      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229, which: 229 })
      textarea.value = '中'
      fireEvent.compositionEnd(textarea)
    })
    expect(sendInputMock.mock.calls.map((call) => call[0])).toEqual(['中'])
    expect(textarea.value).toBe('\u200b\u200b')
  })
  it('does not flush raw composition text as english when compositionstart is missing', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.textarea).toBeTruthy())
    vi.useFakeTimers()
    const textarea = api.textarea as HTMLTextAreaElement
    act(() => {
      textarea.value = 'zhong'
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'zhong' }))
    })
    act(() => {
      vi.advanceTimersByTime(650)
    })
    expect(sendInputMock).not.toHaveBeenCalled()
    act(() => {
      textarea.value = '中'
      fireEvent.compositionEnd(textarea)
    })
    expect(sendInputMock.mock.calls.map((call) => call[0])).toEqual(['中'])
    expect(textarea.value).toBe('\u200b\u200b')
  })
  it('commits replacement text after a short debounce so mobile prediction input stays responsive', async () => {
    render(<Harness />)
    await waitFor(() => expect(api.textarea).toBeTruthy())
    vi.useFakeTimers()
    const textarea = api.textarea as HTMLTextAreaElement
    act(() => {
      textarea.value = '\u200bhello world\u200b'
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'hello world' }))
    })
    expect(textarea.value).toContain('hello world')
    expect(sendInputMock).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(79)
    })
    expect(sendInputMock).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sendInputMock).toHaveBeenCalledWith('hello world')
    expect(textarea.value).toBe('\u200b\u200b')
  })
  it('does not enable mobile keyboard mode on coarse-pointer desktop user agents', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36' })
    render(<Harness />)
    await waitFor(() => expect(api.focusKeyboard).toBeTruthy())
    expect(api.isMobile).toBe(false)
  })
})
