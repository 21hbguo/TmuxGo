import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef } from 'react'
import { useMobileKeyboard } from './useMobileKeyboard'

let api: { focusKeyboard?: () => void; textarea?: HTMLTextAreaElement | null } = {}

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
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 390, height: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() },
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
    fireEvent.pointerDown(button)
    api.textarea?.blur()
    await waitFor(() => expect(document.body.classList.contains('keyboard-open')).toBe(true))
    expect(document.activeElement).toBe(api.textarea)
    button.remove()
  })
})
