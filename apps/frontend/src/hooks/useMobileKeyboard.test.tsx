import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef } from 'react'
import { useMobileKeyboard } from './useMobileKeyboard'

let api: { focusKeyboard?: () => void; textarea?: HTMLTextAreaElement | null } = {}
let viewportTarget: EventTarget

function Harness() {
  const terminalRef = useRef<HTMLDivElement>(null)
  const { textareaRef, focusKeyboard } = useMobileKeyboard(vi.fn(), terminalRef)
  useEffect(() => {
    api = { focusKeyboard, textarea: textareaRef.current }
  }, [focusKeyboard, textareaRef])
  return <div ref={terminalRef}><textarea ref={textareaRef} /></div>
}

describe('useMobileKeyboard', () => {
  beforeEach(() => {
    api = {}
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
  it('does not emit keyboard close events for closed viewport resize', async () => {
    const events: Array<{ open?: boolean; inset?: number }> = []
    window.addEventListener('mobile-keyboard-change', ((event: CustomEvent) => events.push(event.detail || {})) as EventListener)
    render(<Harness />)
    await waitFor(() => expect(api.focusKeyboard).toBeTruthy())
    window.visualViewport?.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual([])
  })
})
