'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'

interface PromptDialogProps {
  open: boolean
  title: string
  defaultValue?: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function PromptDialog({ open, title, defaultValue = '', confirmLabel, cancelLabel, onConfirm, onCancel }: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [open, defaultValue])

  if (!open) return null
  return <ModalPortal>
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">{title}</div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onConfirm(value.trim()) }
            if (e.key === 'Escape') onCancel()
          }}
          className="mt-3 w-full rounded-apple border border-[var(--line)] bg-bg-0 px-3 py-2 text-sm text-text-1 outline-none focus:border-accent"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="primary" size="sm" onClick={() => onConfirm(value.trim())}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
