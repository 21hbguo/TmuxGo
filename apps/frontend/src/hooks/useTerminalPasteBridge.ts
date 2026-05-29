'use client'
import { useCallback, useRef } from 'react'
import { extractClipboardText } from '@/lib/clipboard-text'

const KEYBOARD_PASTE_FALLBACK_DELAY = 160

export function useTerminalPasteBridge() {
  const keyboardPasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keyboardPastePendingRef = useRef(false)
  const lastPasteTextRef = useRef('')
  const lastPasteAtRef = useRef(0)
  const clearKeyboardPasteTimer = useCallback(() => {
    if (!keyboardPasteTimerRef.current) return
    clearTimeout(keyboardPasteTimerRef.current)
    keyboardPasteTimerRef.current = null
  }, [])
  const requestTerminalPaste = useCallback((text?: string) => {
    if (text) {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text, source: 'system' } }))
      return
    }
    window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste'))
  }, [])
  const markPasteForwarded = useCallback((text: string) => {
    lastPasteTextRef.current = text
    lastPasteAtRef.current = Date.now()
  }, [])
  const shouldSkipDuplicatePaste = useCallback((text: string) => Date.now() - lastPasteAtRef.current < 160 && text === lastPasteTextRef.current, [])
  const scheduleKeyboardPasteFallback = useCallback((focus: () => void) => {
    clearKeyboardPasteTimer()
    keyboardPastePendingRef.current = true
    keyboardPasteTimerRef.current = setTimeout(() => {
      keyboardPasteTimerRef.current = null
      keyboardPastePendingRef.current = false
      focus()
      requestTerminalPaste()
    }, KEYBOARD_PASTE_FALLBACK_DELAY)
  }, [clearKeyboardPasteTimer, requestTerminalPaste])
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const text = extractClipboardText(e.clipboardData)
    keyboardPastePendingRef.current = false
    if (!text) {
      clearKeyboardPasteTimer()
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      requestTerminalPaste()
      return
    }
    if (shouldSkipDuplicatePaste(text)) {
      clearKeyboardPasteTimer()
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      return
    }
    clearKeyboardPasteTimer()
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    markPasteForwarded(text)
    requestTerminalPaste(text)
  }, [clearKeyboardPasteTimer, markPasteForwarded, requestTerminalPaste, shouldSkipDuplicatePaste])
  const handlePasteInput = useCallback((e: InputEvent) => {
    const isPasteInput = e.inputType === 'insertFromPaste' || keyboardPastePendingRef.current
    if (!isPasteInput) return
    const target = e.target
    const text = typeof e.data === 'string' && e.data ? e.data : target instanceof HTMLTextAreaElement ? target.value : ''
    keyboardPastePendingRef.current = false
    clearKeyboardPasteTimer()
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (target instanceof HTMLTextAreaElement) target.value = ''
    if (text && shouldSkipDuplicatePaste(text)) return
    if (text) markPasteForwarded(text)
    requestTerminalPaste(text)
  }, [clearKeyboardPasteTimer, markPasteForwarded, requestTerminalPaste, shouldSkipDuplicatePaste])
  const dispose = useCallback(() => {
    clearKeyboardPasteTimer()
    keyboardPastePendingRef.current = false
  }, [clearKeyboardPasteTimer])
  return { scheduleKeyboardPasteFallback, handlePaste, handlePasteInput, dispose }
}
