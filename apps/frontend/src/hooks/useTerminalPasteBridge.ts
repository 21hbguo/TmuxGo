'use client'
import { useCallback, useMemo, useRef } from 'react'
import { extractClipboardImageFiles } from '@/lib/clipboard-files'
import { extractClipboardText } from '@/lib/clipboard-text'
import { armImeDiagnostics, recordImeDiagnostic } from '@/lib/ime-diagnostics'

const KEYBOARD_PASTE_FALLBACK_DELAY = 160
function recordImeDebug(event: string, data?: Record<string, unknown>) {
  recordImeDiagnostic('paste-bridge', event, data)
}
function clearTextareaTarget(target: EventTarget | null) {
  if (target instanceof HTMLTextAreaElement) target.value = ''
}

export function useTerminalPasteBridge(onPasteFiles?: (files: File[]) => void) {
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
    armImeDiagnostics('keyboard-paste-fallback')
    recordImeDebug('schedule-keyboard-paste-fallback')
    keyboardPasteTimerRef.current = setTimeout(() => {
      keyboardPasteTimerRef.current = null
      keyboardPastePendingRef.current = false
      recordImeDebug('keyboard-paste-fallback-fire')
      requestTerminalPaste()
    }, KEYBOARD_PASTE_FALLBACK_DELAY)
  }, [clearKeyboardPasteTimer, requestTerminalPaste])
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const files = extractClipboardImageFiles(e.clipboardData)
    armImeDiagnostics('native-paste')
    recordImeDebug('paste', { hasFiles: files.length > 0, textLength: extractClipboardText(e.clipboardData).length, target: e.target instanceof HTMLElement ? `${e.target.tagName}.${e.target.className}` : '' })
    if (files.length) {
      keyboardPastePendingRef.current = false
      clearKeyboardPasteTimer()
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      clearTextareaTarget(e.target)
      onPasteFiles?.(files)
      return
    }
    const text = extractClipboardText(e.clipboardData)
    const target = e.target
    keyboardPastePendingRef.current = false
    if (!text) {
      recordImeDebug('paste-empty')
      clearKeyboardPasteTimer()
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      clearTextareaTarget(target)
      requestTerminalPaste()
      return
    }
    if (shouldSkipDuplicatePaste(text)) {
      recordImeDebug('paste-skip-duplicate', { textLength: text.length })
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
    recordImeDebug('paste-forward', { textLength: text.length })
    markPasteForwarded(text)
    requestTerminalPaste(text)
  }, [clearKeyboardPasteTimer, markPasteForwarded, onPasteFiles, requestTerminalPaste, shouldSkipDuplicatePaste])
  const handlePasteInput = useCallback((e: InputEvent) => {
    const isPasteInput = e.inputType === 'insertFromPaste'
    recordImeDebug('paste-input', { inputType: e.inputType || '', data: e.data || '', pending: keyboardPastePendingRef.current })
    if (!isPasteInput && keyboardPastePendingRef.current) {
      keyboardPastePendingRef.current = false
      clearKeyboardPasteTimer()
    }
    if (!isPasteInput) return
    keyboardPastePendingRef.current = false
    clearKeyboardPasteTimer()
  }, [clearKeyboardPasteTimer])
  const dispose = useCallback(() => {
    clearKeyboardPasteTimer()
    keyboardPastePendingRef.current = false
  }, [clearKeyboardPasteTimer])
  return useMemo(() => ({ scheduleKeyboardPasteFallback, handlePaste, handlePasteInput, dispose }), [scheduleKeyboardPasteFallback, handlePaste, handlePasteInput, dispose])
}
