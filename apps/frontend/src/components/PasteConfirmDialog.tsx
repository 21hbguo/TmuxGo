'use client'

import { useEffect, useRef, type MouseEvent, type TouchEvent } from 'react'
import { useTranslation } from '@/i18n'
import { ModalPortal } from './ModalPortal'

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
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const isManual = mode === 'manual'
  useEffect(() => {
    if (!open || !isManual) return
    const focusToEnd = () => {
      const textarea = textareaRef.current
      if (!textarea) return
      const pos = textarea.value.length
      textarea.focus()
      textarea.setSelectionRange(pos, pos)
    }
    focusToEnd()
    const frame = requestAnimationFrame(focusToEnd)
    const timer = setTimeout(focusToEnd, 0)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [open, isManual])
  useEffect(() => {
    if (!open || isManual) return
    const handleDocumentKeyDown = (e: KeyboardEvent) => {
      if (dialogRef.current?.contains(e.target as Node)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return
      e.preventDefault()
      e.stopPropagation()
      if (text) onSend()
    }
    document.addEventListener('keydown', handleDocumentKeyDown, true)
    return () => document.removeEventListener('keydown', handleDocumentKeyDown, true)
  }, [open, isManual, text, onSend, onCancel])
  if (!open) return null
  const preventFocus = (e: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => {
    e.preventDefault()
  }
  return <ModalPortal>
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-2xl rounded-lg border p-5"
        onClick={(e) => e.stopPropagation()}
        onKeyDownCapture={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
            return
          }
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.shiftKey) return
          e.preventDefault()
          if (text) onSend()
        }}
      >
        <div className="text-lg text-text-1">{isManual ? t('paste.manualTitle') : t('paste.title')}</div>
        {isManual && <div className="mt-2 text-sm text-text-3">{t('paste.manualDesc')}</div>}
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-3">
          {meta.map((item) => (
            <div key={item} className="rounded bg-bg-2 px-2 py-1">{item}</div>
          ))}
        </div>
        <textarea ref={textareaRef} value={text} onChange={(e) => onTextChange?.(e.target.value)} className="tmuxgo-control tmuxgo-textarea mt-4 h-48 max-h-[40vh] w-full resize-none rounded p-3 text-xs" autoFocus={isManual} spellCheck={false} />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button onMouseDown={preventFocus} onTouchStart={preventFocus} onClick={onCancel} className="rounded px-4 py-2 text-sm text-text-3 hover:text-text-1">{t('paste.cancel')}</button>
          {isManual && <button onMouseDown={preventFocus} onTouchStart={preventFocus} onClick={onRetryPermission} className="rounded bg-bg-2 px-4 py-2 text-sm text-text-1 hover:bg-bg-0">{t('paste.retryPermission')}</button>}
          <button onMouseDown={preventFocus} onTouchStart={preventFocus} onClick={onEscapeSend} className="rounded bg-bg-2 px-4 py-2 text-sm text-text-1 hover:bg-bg-0">{t('paste.escapePaste')}</button>
          <button onMouseDown={preventFocus} onTouchStart={preventFocus} onClick={onSend} disabled={!text} className="rounded bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50">{t('paste.send')}</button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
