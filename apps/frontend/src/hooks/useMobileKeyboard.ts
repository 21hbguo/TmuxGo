'use client'

import { useEffect, useRef, useCallback } from 'react'

const SENTINEL = '\u200b\u200b'
const SENTINEL_CENTER = 1
const KEYBOARD_OPEN_THRESHOLD = 120
const KEYBOARD_CLOSE_THRESHOLD = 70

export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(pointer: coarse)').matches) return true
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

export function useMobileKeyboard(
  sendInput: (data: string) => void,
  terminalRef: React.RefObject<HTMLDivElement | null>,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const keyboardOpenRef = useRef(false)
  const isMobile = useRef(isMobileDevice())

  const clearValue = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.value = SENTINEL
    try { ta.setSelectionRange(SENTINEL_CENTER, SENTINEL_CENTER) } catch {}
  }, [])

  const ensureSentinel = useCallback(() => {
    const ta = textareaRef.current
    if (!ta || ta.value.includes(SENTINEL.charAt(0))) return
    clearValue()
  }, [clearValue])

  useEffect(() => {
    if (!isMobile.current) return
    const ta = textareaRef.current
    if (!ta) return

    clearValue()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (composingRef.current || e.isComposing) return
      if (e.key === 'Backspace') {
        e.preventDefault()
        sendInput('\x7f')
        clearValue()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        sendInput('\r')
        clearValue()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        sendInput('\t')
        clearValue()
      }
    }

    const handleBeforeInput = (e: InputEvent) => {
      if (composingRef.current) return
      if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
        const text = e.data
        if (text) {
          e.preventDefault()
          sendInput(text)
          clearValue()
        }
      }
    }

    const handleInput = (e: Event) => {
      if (composingRef.current) {
        clearValue()
        return
      }
      const inputEvent = e as InputEvent
      if (inputEvent.inputType === 'deleteContentBackward') {
        sendInput('\x7f')
        clearValue()
        return
      }
      const ta = textareaRef.current
      if (!ta) return
      const raw = ta.value
      const text = raw.replace(/\u200b/g, '')
      if (text) {
        sendInput(text)
      }
      clearValue()
    }

    const handleCompositionStart = () => {
      composingRef.current = true
      if (ta) ta.value = ''
    }

    const handleCompositionEnd = () => {
      composingRef.current = false
      const raw = ta.value
      const text = raw.replace(/\u200b/g, '')
      if (text) {
        sendInput(text)
      }
      clearValue()
    }

    const handleFocus = () => {
      setTimeout(() => clearValue(), 10)
    }

    ta.addEventListener('keydown', handleKeyDown)
    ta.addEventListener('beforeinput', handleBeforeInput as EventListener)
    ta.addEventListener('input', handleInput)
    ta.addEventListener('compositionstart', handleCompositionStart)
    ta.addEventListener('compositionend', handleCompositionEnd)
    ta.addEventListener('focus', handleFocus)

    return () => {
      ta.removeEventListener('keydown', handleKeyDown)
      ta.removeEventListener('beforeinput', handleBeforeInput as EventListener)
      ta.removeEventListener('input', handleInput)
      ta.removeEventListener('compositionstart', handleCompositionStart)
      ta.removeEventListener('compositionend', handleCompositionEnd)
      ta.removeEventListener('focus', handleFocus)
    }
  }, [sendInput, clearValue])

  useEffect(() => {
    if (!isMobile.current) return

    const handleViewportResize = () => {
      const vv = window.visualViewport
      if (!vv) return
      const inset = Math.max(0, window.innerHeight - vv.height)
      const isOpen = keyboardOpenRef.current
      if (!isOpen && inset >= KEYBOARD_OPEN_THRESHOLD) {
        keyboardOpenRef.current = true
        document.body.classList.add('keyboard-open')
        document.documentElement.style.setProperty('--mobile-keyboard-inset', `${inset}px`)
      } else if (isOpen && inset <= KEYBOARD_CLOSE_THRESHOLD) {
        keyboardOpenRef.current = false
        document.body.classList.remove('keyboard-open')
        document.documentElement.style.setProperty('--mobile-keyboard-inset', '0px')
      } else if (isOpen) {
        document.documentElement.style.setProperty('--mobile-keyboard-inset', `${inset}px`)
      }
    }

    window.visualViewport?.addEventListener('resize', handleViewportResize)
    return () => {
      window.visualViewport?.removeEventListener('resize', handleViewportResize)
      document.body.classList.remove('keyboard-open')
      document.documentElement.style.setProperty('--mobile-keyboard-inset', '0px')
    }
  }, [])

  const focusKeyboard = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus({ preventScroll: true })
    clearValue()
  }, [clearValue])

  return { textareaRef, focusKeyboard, isMobile: isMobile.current }
}
