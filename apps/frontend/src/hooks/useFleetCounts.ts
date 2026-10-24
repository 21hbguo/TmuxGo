import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@/types'

export interface FleetCounts {
  /** blocked = 等我处理的数量：ActivityBar 角标用它，不用总数 */
  blocked: number
  total: number
}

const EMPTY: FleetCounts = { blocked: 0, total: 0 }

// 角标数据源就是 sessions 缓存本身：agent_state 帧由 PaneNotifications 原地 patch 这份缓存，
// 所以订阅 query cache 的变化即可，不必再开一条 WS 订阅或自己轮询。
// 已知边界：还没加载过 session 列表的 host 不计入（缓存里没有它的 pane），
// 面板打开或 SessionPanel 访问过该 host 后自然补齐。
export function countFleetFromCache(queries: { queryKey: readonly unknown[]; data: unknown }[]): FleetCounts {
  let blocked = 0
  let total = 0
  for (const query of queries) {
    const key = query.queryKey
    if (!Array.isArray(key) || key[0] !== 'sessions' || key.length !== 2) continue
    for (const session of (query.data as Session[] | undefined) || []) {
      for (const pane of session.agents || []) {
        total += 1
        if (pane.agentStatus === 'blocked') blocked += 1
      }
    }
  }
  return { blocked, total }
}

export function useFleetCounts(): FleetCounts {
  const queryClient = useQueryClient()
  const [counts, setCounts] = useState<FleetCounts>(EMPTY)
  useEffect(() => {
    const cache = queryClient.getQueryCache()
    const read = () => {
      const next = countFleetFromCache(
        cache.getAll().map((query) => ({ queryKey: query.queryKey, data: query.state.data })),
      )
      setCounts((prev) => (prev.blocked === next.blocked && prev.total === next.total ? prev : next))
    }
    read()
    return cache.subscribe(read)
  }, [queryClient])
  return counts
}
