'use client'

import { ModalPortal } from './ModalPortal'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  tone?: 'danger' | 'default'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, tone = 'default', onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null
  return <ModalPortal>
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-lg border p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">{title}</div>
        <div className="mt-2 text-sm text-text-3">{message}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--sm">{cancelLabel}</button>
          <button onClick={onConfirm} className={`tmuxgo-button tmuxgo-button--sm ${tone === 'danger' ? 'tmuxgo-button--danger' : 'tmuxgo-button--primary'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
