'use client'
import { useEffect } from 'react'
import { subscribeSessionChanges } from '@/lib/session-change-feed'
import { useOptionalQueryClient } from './useOptionalQueryClient'

/**
 * 会话列表近实时刷新：网关那边一发现 tmux 侧 session 增删/改名/window 数变化，
 * 这里就把 ['sessions', hostId] 打脏，观察者立刻重取。
 *
 * enabled 用来避开「placeholder 数据」时段：此时列表显示的是上一个 host 的缓存，
 * 订阅它既没意义也会让 host 切换来回拆装长轮询。
 */
export function useSessionChangeFeed(hostId: string, enabled = true) {
  const queryClient = useOptionalQueryClient()
  useEffect(() => {
    if (!enabled || !hostId || !queryClient) return
    return subscribeSessionChanges(hostId, () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', hostId] })
    })
  }, [enabled, hostId, queryClient])
}
