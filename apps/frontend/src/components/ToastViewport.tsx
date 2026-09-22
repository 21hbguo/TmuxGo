'use client'

import { useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

const ERROR_DURATION_MS = 8000

export function ToastViewport() {
  const toasts = useConsoleStore((s) => s.toasts)
  const removeToast = useConsoleStore((s) => s.removeToast)
  const { t } = useTranslation()
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const timers = timersRef.current
    const ids = new Set(toasts.map((toast) => toast.id))
    // 每个 toast 计时器只建一次：新通知到来不得重置旧通知的剩余寿命
    for (const toast of toasts) {
      if (timers.has(toast.id)) continue
      const duration = toast.durationMs ?? (toast.type === 'error' ? ERROR_DURATION_MS : 2800)
      timers.set(
        toast.id,
        setTimeout(() => removeToast(toast.id), Math.max(500, duration)),
      )
    }
    for (const [id, timer] of timers) {
      if (!ids.has(id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }
  }, [toasts, removeToast])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-[70] flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.type === 'error' ? 'alert' : 'status'}
          className={`tmuxgo-toast pointer-events-auto flex items-start gap-2 ${
            toast.type === 'error' ? 'tmuxgo-toast--error' : toast.type === 'success' ? 'tmuxgo-toast--success' : ''
          }`}
        >
          <span className="min-w-0 flex-1">{toast.message}</span>
          {toast.type === 'error' && (
            <button
              aria-label={t('common.close')}
              className="shrink-0 leading-none text-text-3 hover:text-text-1"
              onClick={() => removeToast(toast.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
