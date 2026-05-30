'use client'

import { useCallback, useMemo, useRef } from 'react'
import { writeClipboardText } from '@/lib/clipboard-text'

type PushToast=(toast:{type:'success'|'error'|'info';message:string;durationMs?:number})=>void

export function useTerminalSelectionSync(pushToast: PushToast) {
  const currentSelectionRef = useRef('')
  const lastCopiedSelectionRef = useRef('')
  const lastCopyNoticeRef = useRef('')
  const lastCopySuccessNoticeRef = useRef('')
  const copySelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const getCopyUnavailableMessage = useCallback((reason: string, selectionLength: number) => {
    if (reason === 'permission_denied') return 'System clipboard blocked by browser, kept in app clipboard. Press Ctrl/Cmd+C to copy.'
    if (reason === 'api_unavailable') return `System clipboard API unavailable${window.isSecureContext ? '' : ' (insecure context)'}, kept in app clipboard`
    return `System clipboard write failed for ${selectionLength} chars, kept in app clipboard`
  }, [])
  const pushCopySuccessToast = useCallback((mode: 'native' | 'fallback', selectionLength: number) => {
    const noticeKey = `${mode}:${selectionLength}`
    if (lastCopySuccessNoticeRef.current === noticeKey) return
    lastCopySuccessNoticeRef.current = noticeKey
    pushToast({ type: 'success', message: `Copied ${selectionLength} chars (${mode})`, durationMs: 900 })
    setTimeout(() => {
      if (lastCopySuccessNoticeRef.current === noticeKey) lastCopySuccessNoticeRef.current = ''
    }, 920)
  }, [pushToast])
  const clearCopySelectionTimer = useCallback(() => {
    const timer = copySelectionTimerRef.current
    if (!timer) return
    clearTimeout(timer)
    copySelectionTimerRef.current = null
  }, [])
  const setSelection = useCallback((selection: string) => {
    currentSelectionRef.current = selection
    if (selection) return
    lastCopiedSelectionRef.current = ''
    lastCopyNoticeRef.current = ''
    clearCopySelectionTimer()
  }, [clearCopySelectionTimer])
  const handleNativeCopyEvent = useCallback((selection: string, e: ClipboardEvent) => {
    if (!selection || !e.clipboardData) return false
    currentSelectionRef.current = selection
    lastCopiedSelectionRef.current = selection
    lastCopyNoticeRef.current = ''
    e.clipboardData.setData('text/plain', selection)
    e.preventDefault()
    e.stopPropagation()
    return true
  }, [])
  const triggerNativeCopy = useCallback((selection: string, restoreFocus?: () => void) => {
    if (!selection || typeof document.execCommand !== 'function') return false
    currentSelectionRef.current = selection
    lastCopiedSelectionRef.current = selection
    lastCopyNoticeRef.current = ''
    let copyHandled = false
    const handleCopy = (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      e.clipboardData.setData('text/plain', selection)
      e.preventDefault()
      copyHandled = true
    }
    document.addEventListener('copy', handleCopy, true)
    const ta = document.createElement('textarea')
    ta.value = selection
    ta.readOnly = true
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.focus({ preventScroll: true })
    ta.select()
    ta.setSelectionRange(0, selection.length)
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    document.removeEventListener('copy', handleCopy, true)
    document.body.removeChild(ta)
    restoreFocus?.()
    return copied && copyHandled
  }, [])
  const copySelectionIfNeeded = useCallback(async (selection: string, force = false) => {
    if (!selection) {
      currentSelectionRef.current = ''
      lastCopiedSelectionRef.current = ''
      lastCopyNoticeRef.current = ''
      return
    }
    if (!force && selection === lastCopiedSelectionRef.current) return
    lastCopiedSelectionRef.current = selection
    const result = await writeClipboardText(selection)
    if (result.unavailable) {
      const noticeKey = `${selection}:${result.reason}`
      if (lastCopyNoticeRef.current === noticeKey) return
      lastCopyNoticeRef.current = noticeKey
      pushToast({ type: 'info', message: getCopyUnavailableMessage(result.reason, selection.length) })
      return
    }
    lastCopyNoticeRef.current = ''
    pushCopySuccessToast('fallback', selection.length)
  }, [getCopyUnavailableMessage, pushCopySuccessToast, pushToast])
  const runCopySelection = useCallback((selection: string, force = false, preferNative = false, restoreFocus?: () => void) => {
    if (preferNative && selection && triggerNativeCopy(selection, restoreFocus)) {
      pushCopySuccessToast('native', selection.length)
      return
    }
    void copySelectionIfNeeded(selection, force)
    requestAnimationFrame(() => {
      void copySelectionIfNeeded(selection)
    })
    setTimeout(() => {
      void copySelectionIfNeeded(selection)
    }, 0)
  }, [copySelectionIfNeeded, pushCopySuccessToast, triggerNativeCopy])
  const scheduleCopySelection = useCallback((selection: string, delay = 24) => {
    clearCopySelectionTimer()
    copySelectionTimerRef.current = setTimeout(() => {
      copySelectionTimerRef.current = null
      runCopySelection(selection)
    }, delay)
  }, [clearCopySelectionTimer, runCopySelection])
  const dispose = useCallback(() => {
    clearCopySelectionTimer()
  }, [clearCopySelectionTimer])
  return useMemo(() => ({
    clearCopySelectionTimer,
    copySelectionIfNeeded,
    currentSelectionRef,
    dispose,
    handleNativeCopyEvent,
    runCopySelection,
    scheduleCopySelection,
    setSelection,
    triggerNativeCopy,
  }), [clearCopySelectionTimer, copySelectionIfNeeded, dispose, handleNativeCopyEvent, runCopySelection, scheduleCopySelection, setSelection, triggerNativeCopy])
}
