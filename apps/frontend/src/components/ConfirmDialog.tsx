'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  tone?: 'danger' | 'default'
  /** 批量对象清单：批量结束会话/窗口等场景列出将处理的对象 */
  items?: string[]
  /** 外部执行中状态；onConfirm 返回 Promise 时内部也会进入执行中，防重复确认 */
  busy?: boolean
  onConfirm: () => void | Promise<unknown>
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  items,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const busyState = busy || confirming

  useEffect(() => {
    if (!open) return
    setConfirming(false)
    // 关闭时焦点还给原触发元素；初始焦点走 cancel 按钮的 autoFocus
    // （ModalPortal 二次挂载时普通 useEffect 拿不到 ref）。
    // 触发元素可能已随操作结果卸载（如被删的行），仅仍在文档中时才回焦，
    // 否则 focus 调用落空、焦点错误地掉到背后的终端
    const previouslyFocused = document.activeElement as HTMLElement | null
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [open])

  useEffect(() => {
    // busy 时两个按钮都 disabled，原焦点没有落脚点；
    // 先泊到容器（tabIndex=-1 仅程序聚焦），后续 Tab 由 handleKeyDown 的 busy 分支钳制
    if (open && busyState) dialogRef.current?.focus()
  }, [open, busyState])

  if (!open) return null

  const handleConfirm = () => {
    if (busyState) return
    const result = onConfirm()
    // Promise 期间保持执行中：双击/连点只提交一次。
    // 用 then(fulfilled, rejected) 而非 finally：finally 返回的新 Promise 会延续拒绝，
    // 形成未处理拒绝链；错误提示归调用方（且只提示一次），组件只负责恢复执行态、允许重试
    if (result && typeof result.then === 'function') {
      setConfirming(true)
      result.then(
        () => setConfirming(false),
        () => setConfirming(false),
      )
    }
  }
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!busyState) onCancel()
      return
    }
    if (e.key !== 'Tab') return
    if (busyState) {
      // busy 时两按钮均 disabled，下方 focusables 查询为空会让 Tab 默认行为放跑焦点；
      // 单独钳制：preventDefault + 焦点收回容器，正/反向 Tab 均不离开弹窗
      e.preventDefault()
      if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus()
      return
    }
    // 焦点圈禁在弹窗内，Tab 不穿到背后的终端
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ) || [],
    )
    if (!focusables.length) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    // 容器自身（tabIndex=-1）可持焦但不在循环序列里：busy 结束焦点正泊在容器上，
    // 这里按“不在序列”处理，否则容器上的 Shift+Tab 会默认后退逃出弹窗
    const inCycle = !!active && focusables.includes(active)
    if (e.shiftKey && (active === first || !inCycle)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !inCycle)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center tmuxgo-scrim p-4"
        onClick={busyState ? undefined : onCancel}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-5 outline-none"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <div className="text-lg text-text-1">{title}</div>
          <div className="mt-2 text-sm text-text-3">{message}</div>
          {items && items.length > 0 && (
            <div className="tmuxgo-scrollbar mt-2 max-h-32 overflow-y-auto rounded border border-[var(--line)] px-2 py-1">
              {items.map((item) => (
                <div key={item} className="truncate text-xs text-text-2">
                  {item}
                </div>
              ))}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button autoFocus variant="ghost" size="sm" disabled={busyState} onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              size="sm"
              disabled={busyState}
              onClick={handleConfirm}
            >
              {busyState ? `${confirmLabel}…` : confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
