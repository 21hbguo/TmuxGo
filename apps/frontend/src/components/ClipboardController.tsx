'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { analyzePaste, escapePaste } from '@/lib/paste-safety'
import { readClipboardTextOnly, writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { PasteConfirmDialog } from './PasteConfirmDialog'

export function ClipboardController() {
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [pendingPaste, setPendingPaste] = useState<{ text: string; meta: string[]; mode?: 'confirm' | 'manual'; source?: 'system' | 'memory' | 'empty' } | null>(null)
  const focusAfterCloseRef = useRef(false)
  const focusTerminal = useCallback(() => {
    const focusNow = () => {
      window.dispatchEvent(new CustomEvent('tmuxgo-focus-terminal'))
      const terminal = document.querySelector('[data-terminal]') as HTMLElement | null
      const input = terminal?.querySelector('.xterm-helper-textarea, textarea') as HTMLTextAreaElement | null
      terminal?.focus({ preventScroll: true })
      input?.focus({ preventScroll: true })
    }
    focusNow()
    requestAnimationFrame(focusNow)
    setTimeout(focusNow, 0)
    setTimeout(focusNow, 32)
    setTimeout(focusNow, 96)
  }, [])
  const closePasteDialog = useCallback(() => {
    focusAfterCloseRef.current = true
    flushSync(() => setPendingPaste(null))
    focusTerminal()
  }, [focusTerminal])
  const sendTerminalInput = useCallback((data: string) => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data } }))
  }, [])
  const routePasteText = useCallback((text: string, source: 'system' | 'memory' | 'empty' = 'system') => {
    if (!text) return false
    const analysis = analyzePaste(text)
    const meta = []
    if (analysis.hasNewline) meta.push('multi-line')
    if (analysis.hasControlChars) meta.push('control chars')
    if (analysis.isLong) meta.push(`${text.length} chars`)
    if (source === 'memory') meta.push('app clipboard')
    setPendingPaste({ text, meta, source })
    return false
  }, [])
  const handleCopy = useCallback(async () => {
    const text = await requestTerminalSelection()
    if (!text) return
    const result = await writeClipboardText(text)
    if (!result.copied) {
      pushToast({ type: 'error', message: 'Copy failed' })
      return
    }
    if (result.unavailable) pushToast({ type: 'info', message: 'Clipboard unavailable, kept in app' })
  }, [pushToast])
  const handlePaste = useCallback(async () => {
    try {
      const result = await readClipboardTextOnly()
      const text = result.text
      if (!text) {
        if (result.unavailable) setPendingPaste({ text: '', meta: ['clipboard unavailable'], mode: 'manual' })
        else pushToast({ type: 'info', message: 'Clipboard is empty' })
        return
      }
      routePasteText(text, result.source)
    } catch (err) {
      setPendingPaste({ text: '', meta: ['clipboard unavailable'], mode: 'manual' })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Paste failed' })
    }
  }, [pushToast, routePasteText])
  useEffect(() => {
    if (pendingPaste || !focusAfterCloseRef.current) return
    focusAfterCloseRef.current = false
    focusTerminal()
  }, [focusTerminal, pendingPaste])
  useEffect(() => {
    const onCopy = () => void handleCopy()
    const onPaste = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; source?: 'system' | 'memory' }>).detail
      if (detail?.text) {
        routePasteText(detail.text, detail.source || 'system')
        return
      }
      void handlePaste()
    }
    window.addEventListener('tmuxgo-request-terminal-copy', onCopy)
    window.addEventListener('tmuxgo-request-terminal-paste', onPaste)
    return () => {
      window.removeEventListener('tmuxgo-request-terminal-copy', onCopy)
      window.removeEventListener('tmuxgo-request-terminal-paste', onPaste)
    }
  }, [handleCopy, handlePaste, routePasteText])
  return (
    <PasteConfirmDialog
      open={!!pendingPaste}
      text={pendingPaste?.text || ''}
      meta={pendingPaste?.meta || []}
      mode={pendingPaste?.mode}
      onTextChange={(text) => setPendingPaste((current) => current ? { ...current, text } : current)}
      onRetryPermission={() => void handlePaste()}
      onCancel={closePasteDialog}
      onSend={() => {
        if (pendingPaste) {
          sendTerminalInput(pendingPaste.text)
          if (pendingPaste.source === 'memory') pushToast({ type: 'info', message: 'Pasted from app clipboard' })
        }
        closePasteDialog()
      }}
      onEscapeSend={() => {
        if (pendingPaste) {
          sendTerminalInput(escapePaste(pendingPaste.text))
          if (pendingPaste.source === 'memory') pushToast({ type: 'info', message: 'Pasted from app clipboard' })
        }
        closePasteDialog()
      }}
    />
  )
}
