'use client'

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
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg border border-[var(--line)] bg-bg-1 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">{title}</div>
        <div className="mt-2 text-sm text-text-3">{message}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded px-4 py-2 text-sm text-text-3 hover:text-text-1">{cancelLabel}</button>
          <button onClick={onConfirm} className={`rounded px-4 py-2 text-sm ${tone === 'danger' ? 'bg-red-900/40 text-red-300 hover:bg-red-900/60' : 'bg-accent/20 text-accent hover:bg-accent/30'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
