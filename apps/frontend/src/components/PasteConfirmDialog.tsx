'use client'

import { useTranslation } from '@/i18n'

interface PasteConfirmDialogProps {
  open: boolean
  text: string
  meta: string[]
  mode?: 'confirm' | 'manual'
  onTextChange?: (text: string) => void
  onRetryPermission?: () => void
  onSend: () => void
  onEscapeSend: () => void
  onCancel: () => void
}

export function PasteConfirmDialog({ open, text, meta, mode = 'confirm', onTextChange, onRetryPermission, onSend, onEscapeSend, onCancel }: PasteConfirmDialogProps) {
  if (!open) return null
  const isManual = mode === 'manual'
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-2xl rounded-lg border border-[var(--line)] bg-bg-1 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">{isManual ? t('paste.manualTitle') : t('paste.title')}</div>
        {isManual && <div className="mt-2 text-sm text-text-3">{t('paste.manualDesc')}</div>}
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-3">
          {meta.map((item) => (
            <div key={item} className="rounded bg-bg-2 px-2 py-1">{item}</div>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => onTextChange?.(e.target.value)}
          className="tmuxgo-control tmuxgo-textarea mt-4 h-48 w-full resize-none rounded p-3 text-xs"
          autoFocus
          spellCheck={false}
        />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button onClick={onCancel} className="rounded px-4 py-2 text-sm text-text-3 hover:text-text-1">{t('paste.cancel')}</button>
          {isManual && <button onClick={onRetryPermission} className="rounded bg-bg-2 px-4 py-2 text-sm text-text-1 hover:bg-bg-0">{t('paste.retryPermission')}</button>}
          <button onClick={onEscapeSend} className="rounded bg-bg-2 px-4 py-2 text-sm text-text-1 hover:bg-bg-0">{t('paste.escapePaste')}</button>
          <button onClick={onSend} disabled={!text} className="rounded bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50">{t('paste.send')}</button>
        </div>
      </div>
    </div>
  )
}
