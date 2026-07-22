'use client'

import { Button } from './Button'
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
      <div className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">{title}</div>
        <div className="mt-2 text-sm text-text-3">{message}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
