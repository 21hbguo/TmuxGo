'use client'

import { useEffect, useRef, useCallback } from 'react'

const SENTINEL = '\u200b\u200b'
const SENTINEL_CENTER = 1
const KEYBOARD_OPEN_THRESHOLD = 120
const KEYBOARD_CLOSE_THRESHOLD = 70
const KEYBOARD_EVENT = 'mobile-keyboard-change'

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
  const keepAliveUntilRef = useRef(0)
  const viewportBaseHeightRef = useRef(0)
  const isMobile = useRef(isMobileDevice())
  const getViewportInset = useCallback(() => {
    const vv = window.visualViewport
    if (!vv) return 0
    const currentHeight = vv.height
    if (currentHeight > viewportBaseHeightRef.current) viewportBaseHeightRef.current = currentHeight
    return Math.max(0, viewportBaseHeightRef.current - currentHeight)
  }, [])
  const emitKeyboardChange = useCallback((open: boolean, inset: number) => {
    window.dispatchEvent(new CustomEvent(KEYBOARD_EVENT, { detail: { open, inset } }))
  }, [])
  const openKeyboard = useCallback((inset: number) => {
    keyboardOpenRef.current = true
    document.body.classList.add('keyboard-open')
    const clamped = Math.max(KEYBOARD_OPEN_THRESHOLD, inset)
    document.documentElement.style.setProperty('--mobile-keyboard-inset', `${clamped}px`)
    emitKeyboardChange(true, clamped)
  }, [emitKeyboardChange])
  const closeKeyboard = useCallback(() => {
    if (!keyboardOpenRef.current) {
      emitKeyboardChange(false, 0)
      return
    }
    keyboardOpenRef.current = false
    document.body.classList.remove('keyboard-open')
    document.documentElement.style.setProperty('--mobile-keyboard-inset', '0px')
    emitKeyboardChange(false, 0)
  }, [emitKeyboardChange])
  const isKeyboardOwnerActive = useCallback(() => {
    const ta = textareaRef.current
    return !!ta && (document.activeElement === ta || Date.now() <= keepAliveUntilRef.current)
  }, [])

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
  const focusKeyboard = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    keepAliveUntilRef.current = Date.now() + 1500
    const inset = getViewportInset()
    openKeyboard(inset || KEYBOARD_OPEN_THRESHOLD)
    ta.focus({ preventScroll: true })
    clearValue()
  }, [clearValue, getViewportInset, openKeyboard])

  useEffect(() => {
    if (!isMobile.current) return
    const ta = textareaRef.current
    if (!ta) return
    const vv = window.visualViewport
    if (vv?.height) viewportBaseHeightRef.current = vv.height

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
      keepAliveUntilRef.current = Date.now() + 1500
      const inset = getViewportInset()
      openKeyboard(inset)
      setTimeout(() => clearValue(), 10)
    }
    const handleKeepAliveCapture = (e: Event) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest('input,textarea,select,[contenteditable="true"]')) return
      if (!target.closest('[data-keep-mobile-keyboard]')) return
      keepAliveUntilRef.current = Date.now() + 500
      if (target.closest('button,a,[role="button"]')) e.preventDefault()
      requestAnimationFrame(() => focusKeyboard())
    }
    const handleBlur = () => {
      if (Date.now() > keepAliveUntilRef.current) {
        closeKeyboard()
        return
      }
      requestAnimationFrame(() => focusKeyboard())
    }

    ta.addEventListener('keydown', handleKeyDown)
    ta.addEventListener('beforeinput', handleBeforeInput as EventListener)
    ta.addEventListener('input', handleInput)
    ta.addEventListener('compositionstart', handleCompositionStart)
    ta.addEventListener('compositionend', handleCompositionEnd)
    ta.addEventListener('focus', handleFocus)
    ta.addEventListener('blur', handleBlur)
    document.addEventListener('pointerdown', handleKeepAliveCapture, true)
    document.addEventListener('touchstart', handleKeepAliveCapture, true)
    document.addEventListener('mousedown', handleKeepAliveCapture, true)

    return () => {
      ta.removeEventListener('keydown', handleKeyDown)
      ta.removeEventListener('beforeinput', handleBeforeInput as EventListener)
      ta.removeEventListener('input', handleInput)
      ta.removeEventListener('compositionstart', handleCompositionStart)
      ta.removeEventListener('compositionend', handleCompositionEnd)
      ta.removeEventListener('focus', handleFocus)
      ta.removeEventListener('blur', handleBlur)
      document.removeEventListener('pointerdown', handleKeepAliveCapture, true)
      document.removeEventListener('touchstart', handleKeepAliveCapture, true)
      document.removeEventListener('mousedown', handleKeepAliveCapture, true)
    }
  }, [sendInput, clearValue, focusKeyboard, closeKeyboard, openKeyboard, getViewportInset])

  useEffect(() => {
    if (!isMobile.current) return

    const handleViewportResize = () => {
      const vv = window.visualViewport
      if (!vv) return
      if (!isKeyboardOwnerActive() && Date.now() > keepAliveUntilRef.current) {
        if (!keyboardOpenRef.current && vv.height > viewportBaseHeightRef.current) viewportBaseHeightRef.current = vv.height
        closeKeyboard()
        return
      }
      const inset = getViewportInset()
      const isOpen = keyboardOpenRef.current
      if (!isOpen && inset >= KEYBOARD_OPEN_THRESHOLD) {
        openKeyboard(inset)
      } else if (isOpen && inset <= KEYBOARD_CLOSE_THRESHOLD) {
        closeKeyboard()
      } else if (isOpen) {
        document.documentElement.style.setProperty('--mobile-keyboard-inset', `${inset}px`)
        emitKeyboardChange(true, inset)
      } else {
        emitKeyboardChange(false, 0)
      }
    }

    handleViewportResize()
    window.visualViewport?.addEventListener('resize', handleViewportResize)
    return () => {
      window.visualViewport?.removeEventListener('resize', handleViewportResize)
      closeKeyboard()
    }
  }, [emitKeyboardChange, closeKeyboard, isKeyboardOwnerActive, openKeyboard, getViewportInset])

  return { textareaRef, focusKeyboard, isMobile: isMobile.current }
}
