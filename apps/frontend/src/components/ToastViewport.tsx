'use client'

import { useEffect } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'

export function ToastViewport() {
  const toasts = useConsoleStore((s) => s.toasts)
  const removeToast = useConsoleStore((s) => s.removeToast)

  useEffect(() => {
    const timers = toasts.map((toast) => setTimeout(() => removeToast(toast.id), 2800))
    return () => timers.forEach((timer) => clearTimeout(timer))
  }, [toasts, removeToast])

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-[70] flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto rounded border px-3 py-2 text-sm ${
            toast.type === 'error'
              ? 'border-red-500/40 bg-red-900/30 text-red-200'
              : toast.type === 'success'
              ? 'border-emerald-500/40 bg-emerald-900/30 text-emerald-200'
              : 'border-[var(--line)] bg-bg-1 text-text-1'
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
