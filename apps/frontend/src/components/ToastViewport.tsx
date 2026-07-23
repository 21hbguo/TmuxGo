'use client'

import { useEffect } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'

export function ToastViewport() {
  const toasts = useConsoleStore((s) => s.toasts)
  const removeToast = useConsoleStore((s) => s.removeToast)

  useEffect(() => {
    const timers = toasts.map((toast) => setTimeout(() => removeToast(toast.id), Math.max(500, toast.durationMs || 2800)))
    return () => timers.forEach((timer) => clearTimeout(timer))
  }, [toasts, removeToast])

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-[70] flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`tmuxgo-toast pointer-events-auto ${
            toast.type === 'error'
              ? 'tmuxgo-toast--error'
              : toast.type === 'success'
              ? 'tmuxgo-toast--success'
              : ''
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
