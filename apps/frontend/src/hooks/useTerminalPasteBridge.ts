'use client'
import { useCallback, useMemo, useRef } from 'react'
import { extractClipboardText } from '@/lib/clipboard-text'

const KEYBOARD_PASTE_FALLBACK_DELAY = 160
function clearTextareaTarget(target: EventTarget | null) {
  if (target instanceof HTMLTextAreaElement) target.value = ''
}

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
  const scheduleKeyboardPasteFallback = useCallback(() => {
    clearKeyboardPasteTimer()
    keyboardPastePendingRef.current = true
    keyboardPasteTimerRef.current = setTimeout(() => {
      keyboardPasteTimerRef.current = null
      keyboardPastePendingRef.current = false
      requestTerminalPaste()
    }, KEYBOARD_PASTE_FALLBACK_DELAY)
  }, [clearKeyboardPasteTimer, requestTerminalPaste])
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const text = extractClipboardText(e.clipboardData)
    const target = e.target
    keyboardPastePendingRef.current = false
    if (!text) {
      clearKeyboardPasteTimer()
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      clearTextareaTarget(target)
      requestTerminalPaste()
      return
    }
    if (shouldSkipDuplicatePaste(text)) {
      clearKeyboardPasteTimer()
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      clearTextareaTarget(target)
      return
    }
    clearKeyboardPasteTimer()
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    clearTextareaTarget(target)
    markPasteForwarded(text)
    requestTerminalPaste(text)
  }, [clearKeyboardPasteTimer, markPasteForwarded, requestTerminalPaste, shouldSkipDuplicatePaste])
  const handlePasteInput = useCallback((e: InputEvent) => {
    const isPasteInput = e.inputType === 'insertFromPaste'
    if (!isPasteInput && keyboardPastePendingRef.current) {
      keyboardPastePendingRef.current = false
      clearKeyboardPasteTimer()
    }
    if (!isPasteInput) return
    const target = e.target
    const text = typeof e.data === 'string' && e.data ? e.data : target instanceof HTMLTextAreaElement ? target.value : ''
    keyboardPastePendingRef.current = false
    clearKeyboardPasteTimer()
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    clearTextareaTarget(target)
    if (text && shouldSkipDuplicatePaste(text)) return
    if (text) markPasteForwarded(text)
    requestTerminalPaste(text)
  }, [clearKeyboardPasteTimer, markPasteForwarded, requestTerminalPaste, shouldSkipDuplicatePaste])
  const dispose = useCallback(() => {
    clearKeyboardPasteTimer()
    keyboardPastePendingRef.current = false
  }, [clearKeyboardPasteTimer])
  return useMemo(() => ({ scheduleKeyboardPasteFallback, handlePaste, handlePasteInput, dispose }), [scheduleKeyboardPasteFallback, handlePaste, handlePasteInput, dispose])
}
