'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { isImeKeyEvent } from '@/lib/terminal-platform'

interface PromptDialogProps {
  open: boolean
  title: string
  defaultValue?: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: (value: string) => void | Promise<unknown>
  onCancel: () => void
}

export function PromptDialog({
  open,
  title,
  defaultValue = '',
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const [confirming, setConfirming] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setConfirming(false)
      setValue(defaultValue)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [open, defaultValue])

  useEscapeClose(onCancel, open && !confirming)

  if (!open) return null
  const submit = () => {
    if (confirming) return
    const result = onConfirm(value.trim())
    // 与 ConfirmDialog 同规：Promise 期间 busy 防重复提交；
    // then 双分支（而非 finally）吞掉拒绝避免未处理拒绝链，错误提示归调用方
    if (result && typeof result.then === 'function') {
      setConfirming(true)
      result.then(
        () => setConfirming(false),
        () => setConfirming(false),
      )
    }
  }

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center tmuxgo-scrim p-4"
        onClick={confirming ? undefined : onCancel}
      >
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-lg text-text-1">{title}</div>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // IME 组字期按键交给输入法：选词 Enter/Escape 不得触发确认/取消
              if (isImeKeyEvent(e.nativeEvent)) return
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            className="tmuxgo-control tmuxgo-input mt-3 w-full rounded-apple px-3 py-2 text-sm"
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={confirming} onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button variant="primary" size="sm" disabled={confirming} onClick={submit}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
