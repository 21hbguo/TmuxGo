'use client'

import { useEffect, useRef, useState } from 'react'
import { useInboxSync } from '@/hooks/useInbox'
import { subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { navigateInboxRoute } from '@/lib/inbox-navigation'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useInboxStore, inboxMessageTitle } from '@/stores/useInboxStore'
import { useTranslation } from '@/i18n'
import type { AgentInboxMessage, InboxMessageRoute } from '@/types'
import { FiInbox, FiX } from 'react-icons/fi'

const TOAST_DURATION_MS = 5000
const MAX_TOASTS = 3

interface InboxToast {
  id: string
  title: string
}

// agent 推送到达的轻提示：进消息镜像 + 未读数 + 可点「查看」的浮条。
// 不复用 useConsoleStore.pushToast——其模型无 action 位，收件箱提示自立门户
export function InboxNotifications({
  onOpenInbox,
  onNavigate,
}: {
  onOpenInbox: () => void
  onNavigate?: (result: 'pane' | 'session' | 'not-found' | 'no-target' | 'error') => void
}) {
  const { t } = useTranslation()
  const queryClient = useOptionalQueryClient()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const [toasts, setToasts] = useState<InboxToast[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate

  const dismissToast = (id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(id)
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }

  useInboxSync({
    onMessageCreated: (message: AgentInboxMessage) => {
      const id = message.id
      setToasts((prev) =>
        [...prev, { id, title: inboxMessageTitle(message) || t('inbox.newMessage') }].slice(-MAX_TOASTS),
      )
      const timer = setTimeout(() => dismissToast(id), TOAST_DURATION_MS)
      timersRef.current.set(id, timer)
    },
  })

  // agent 侧 open=true 推送 → 导航到目标 pane/session；找不到不跳转、留在原地并提示
  useEffect(() => {
    const unsub = subscribeStreamEvent(
      STREAM_EVENT.inboxOpenTarget,
      (detail: { route?: InboxMessageRoute; messageId?: string }) => {
        if (!detail?.route) return
        void navigateInboxRoute(detail.route, queryClient).then((result) => {
          if (result === 'not-found' || result === 'error' || result === 'no-target')
            pushToast({ type: 'error', message: t('inbox.targetMissing') })
          else onNavigateRef.current?.(result)
        })
      },
    )
    return unsub
  }, [queryClient, pushToast, t])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  // 需读 deviceId 订阅以便跟随 store 初始化渲染（无副作用）
  void useInboxStore((state) => state.deviceId)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-24 right-4 z-[72] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} role="status" className="tmuxgo-toast pointer-events-auto flex items-center gap-2">
          <FiInbox aria-hidden="true" className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">{toast.title}</span>
          <button
            type="button"
            className="shrink-0 font-medium text-accent"
            onClick={() => {
              dismissToast(toast.id)
              onOpenInbox()
            }}
          >
            {t('inbox.view')}
          </button>
          <button
            type="button"
            aria-label={t('common.close')}
            className="shrink-0 leading-none text-text-3 hover:text-text-1"
            onClick={() => dismissToast(toast.id)}
          >
            <FiX aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
