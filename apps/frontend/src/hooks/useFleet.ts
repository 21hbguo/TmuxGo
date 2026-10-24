import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { useHosts } from '@/hooks/useApi'
import { sessionsQueryOptions } from '@/hooks/useApi'
import { buildFleet, formatFleetDuration, type FleetFilters } from '@/lib/fleet'
import type { Pane, Session } from '@/types'

// 面板不可见 / 没有 agent pane 时一律不建任何观察者：
// - sessions 查询只在本面板可见时挂载（关掉面板 → 观察者卸载，不再有请求）
// - 任务号是冷数据，随 pane 列表低频刷新，不参与推式通道
export const FLEET_PANE_LIST_STALE_MS = 30000
// 推式通道 30s 没有任何 agent_state 帧才补一次全量（防丢帧）；有帧说明通道活着，不发请求。
// 这不是轮询：间隔内只要有帧就整轮跳过
export const FLEET_ALIGN_MS = 30000

/** 相对时长每分钟重算一次；只重渲染，不触发网络 */
export function useFleetClock(enabled: boolean, intervalMs = 60000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs])
  return now
}

export function useFleetData(options: { visible: boolean; filters?: FleetFilters }) {
  const { visible, filters } = options
  const queryClient = useQueryClient()
  const hostsQuery = useHosts()
  const hosts = useMemo(() => hostsQuery.data || [], [hostsQuery.data])
  const hostIds = useMemo(
    () =>
      hosts
        .map((host) => host.id)
        .filter(Boolean)
        .sort(),
    [hosts],
  )
  // refetchInterval 不设：fleet 自己不做定时轮询，缓存由 agent_state 事件原地 patch
  const sessionQueries = useQueries({
    queries: hostIds.map((hostId) => ({
      ...sessionsQueryOptions(hostId, queryClient),
      enabled: visible && !!hostId,
    })),
  })
  const sessionsByHost = useMemo(() => {
    const map: Record<string, Session[] | undefined> = {}
    hostIds.forEach((hostId, index) => {
      map[hostId] = sessionQueries[index]?.data as Session[] | undefined
    })
    return map
  }, [hostIds, sessionQueries])
  const activeSessions = useMemo(
    () =>
      hostIds.flatMap((hostId) =>
        ((sessionsByHost[hostId] || []) as Session[])
          .filter((session) => (session.agents || []).length)
          .map((session) => ({ hostId, sessionId: session.id })),
      ),
    [hostIds, sessionsByHost],
  )
  // 任务号与 pane 序号来自 pane 列表（冷数据）：只在可见时取，30s 陈旧即重取
  const paneQueries = useQueries({
    queries: activeSessions.map(({ hostId, sessionId }) => ({
      queryKey: ['fleet-panes', hostId, sessionId],
      queryFn: () => api.panes.listBySession(hostId, sessionId),
      enabled: visible,
      staleTime: FLEET_PANE_LIST_STALE_MS,
    })),
  })
  const panesBySession = useMemo(() => {
    const map: Record<string, Pane[] | undefined> = {}
    activeSessions.forEach(({ hostId, sessionId }, index) => {
      map[`${hostId}:${sessionId}`] = paneQueries[index]?.data as Pane[] | undefined
    })
    return map
  }, [activeSessions, paneQueries])
  const fleet = useMemo(
    () => buildFleet({ hosts, sessionsByHost, panesBySession, filters }),
    [hosts, sessionsByHost, panesBySession, filters],
  )
  const refetchAll = useCallback(() => {
    for (const query of sessionQueries) void query.refetch()
    for (const query of paneQueries) void query.refetch()
  }, [sessionQueries, paneQueries])
  useFleetAlign({ enabled: visible, refetch: refetchAll })
  return {
    hosts,
    fleet,
    loading: visible && hostIds.length > 0 && sessionQueries.some((query) => query.isLoading),
    refetch: refetchAll,
  }
}

/**
 * 防丢帧兜底：订阅 agent_state 的**接收侧**事件（不新开订阅帧——服务端每连接只挂一个
 * monitor listener，见 routes/stream.ts 的注释），30s 内一帧都没到才拉一次全量对齐。
 * 面板不可见时 listener 与计时器都不装。
 */
export function useFleetAlign(options: { enabled: boolean; refetch: () => void; intervalMs?: number }) {
  const { enabled, refetch, intervalMs = FLEET_ALIGN_MS } = options
  const lastFrameRef = useRef(0)
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  useEffect(() => {
    if (!enabled) return
    lastFrameRef.current = Date.now()
    const off = subscribeStreamEvent(STREAM_EVENT.agentState, () => {
      lastFrameRef.current = Date.now()
    })
    const timer = setInterval(() => {
      if (Date.now() - lastFrameRef.current < intervalMs) return
      lastFrameRef.current = Date.now()
      refetchRef.current()
    }, intervalMs)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [enabled, intervalMs])
}

/** 表格「停留」列用的格式化入口：面板与测试共用同一份实现 */
export function useFleetDurationFormatter(now: number) {
  return useCallback((since: string | null) => formatFleetDuration(since, now), [now])
}
