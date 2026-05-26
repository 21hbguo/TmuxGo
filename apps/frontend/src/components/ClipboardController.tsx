'use client'

import { useCallback, useEffect, useState } from 'react'
import { analyzePaste, escapePaste } from '@/lib/paste-safety'
import { readClipboardTextOnly, writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { PasteConfirmDialog } from './PasteConfirmDialog'

export function ClipboardController() {
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [pendingPaste, setPendingPaste] = useState<{ text: string; meta: string[]; mode?: 'confirm' | 'manual' } | null>(null)
  const focusTerminal = useCallback(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('tmuxgo-focus-terminal'))
    })
  }, [])
  const sendTerminalInput = useCallback((data: string) => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data } }))
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
      const analysis = analyzePaste(text)
      if (analysis.requiresConfirm) {
        const meta = []
        if (analysis.hasNewline) meta.push('multi-line')
        if (analysis.hasControlChars) meta.push('control chars')
        if (analysis.isLong) meta.push(`${text.length} chars`)
        if (result.source === 'memory') meta.push('app clipboard')
        setPendingPaste({ text, meta })
        return
      }
      sendTerminalInput(text)
      if (result.source === 'memory') pushToast({ type: 'info', message: 'Pasted from app clipboard' })
    } catch (err) {
      setPendingPaste({ text: '', meta: ['clipboard unavailable'], mode: 'manual' })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Paste failed' })
    }
  }, [pushToast, sendTerminalInput])
  useEffect(() => {
    const onCopy = () => void handleCopy()
    const onPaste = () => void handlePaste()
    window.addEventListener('tmuxgo-request-terminal-copy', onCopy)
    window.addEventListener('tmuxgo-request-terminal-paste', onPaste)
    return () => {
      window.removeEventListener('tmuxgo-request-terminal-copy', onCopy)
      window.removeEventListener('tmuxgo-request-terminal-paste', onPaste)
    }
  }, [handleCopy, handlePaste])
  return (
    <PasteConfirmDialog
      open={!!pendingPaste}
      text={pendingPaste?.text || ''}
      meta={pendingPaste?.meta || []}
      mode={pendingPaste?.mode}
      onTextChange={(text) => setPendingPaste((current) => current ? { ...current, text } : current)}
      onRetryPermission={() => void handlePaste()}
      onCancel={() => {
        setPendingPaste(null)
        focusTerminal()
      }}
      onSend={() => {
        if (pendingPaste) sendTerminalInput(pendingPaste.text)
        setPendingPaste(null)
        focusTerminal()
      }}
      onEscapeSend={() => {
        if (pendingPaste) sendTerminalInput(escapePaste(pendingPaste.text))
        setPendingPaste(null)
        focusTerminal()
      }}
    />
  )
}
