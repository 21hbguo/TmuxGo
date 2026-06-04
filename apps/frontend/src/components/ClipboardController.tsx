'use client'

import { useCallback, useEffect, useState } from 'react'
import { analyzePaste, escapePaste } from '@/lib/paste-safety'
import { readClipboardTextOnly, writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { PasteConfirmDialog } from './PasteConfirmDialog'

export function ClipboardController() {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [pendingPaste, setPendingPaste] = useState<{ text: string; meta: string[]; mode?: 'confirm' | 'manual'; source?: 'system' | 'memory' | 'empty' } | null>(null)
  const closePasteDialog = useCallback(() => {
    setPendingPaste(null)
  }, [])
  const sendTerminalInput = useCallback((data: string) => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data } }))
  }, [])
  const routePasteText = useCallback((text: string, source: 'system' | 'memory' | 'empty' = 'system') => {
    if (!text) return false
    const analysis = analyzePaste(text)
    const meta = []
    if (analysis.hasNewline) meta.push(t('clipboard.meta.multiline'))
    if (analysis.hasControlChars) meta.push(t('clipboard.meta.controlChars'))
    if (analysis.isLong) meta.push(`${text.length} chars`)
    if (source === 'memory') meta.push(t('clipboard.meta.appClipboard'))
    setPendingPaste({ text, meta, source })
    return false
  }, [])
  const handleCopy = useCallback(async () => {
    const text = await requestTerminalSelection()
    if (!text) return
    const result = await writeClipboardText(text)
    if (!result.copied) {
      pushToast({ type: 'error', message: t('clipboard.copyFailed') })
      return
    }
    if (result.unavailable) pushToast({ type: 'info', message: t('clipboard.unavailable') })
  }, [pushToast])
  const handlePaste = useCallback(async () => {
    try {
      const result = await readClipboardTextOnly()
      const text = result.text
      if (!text) {
        if (result.unavailable) setPendingPaste({ text: '', meta: [t('clipboard.meta.unavailable')], mode: 'manual' })
        else pushToast({ type: 'info', message: t('clipboard.empty') })
        return
      }
      routePasteText(text, result.source)
    } catch (err) {
      setPendingPaste({ text: '', meta: [t('clipboard.meta.unavailable')], mode: 'manual' })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('clipboard.pasteFailed') })
    }
  }, [pushToast, routePasteText])
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
          if (pendingPaste.source === 'memory') pushToast({ type: 'info', message: t('clipboard.pastedFromApp') })
        }
        closePasteDialog()
      }}
      onEscapeSend={() => {
        if (pendingPaste) {
          sendTerminalInput(escapePaste(pendingPaste.text))
          if (pendingPaste.source === 'memory') pushToast({ type: 'info', message: t('clipboard.pastedFromApp') })
        }
        closePasteDialog()
      }}
    />
  )
}
