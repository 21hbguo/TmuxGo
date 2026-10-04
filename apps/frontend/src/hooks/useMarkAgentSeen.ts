import { useCallback } from 'react'
import { useOptionalQueryClient } from './useOptionalQueryClient'
import { api } from '@/lib/api'
import { summarizeAgentStates } from '@/lib/agent-status'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import type { Session } from '@/types'

// 「标记已查看」统一入口：POST /panes/mark-seen 后乐观把 done 翻成 idle——
// 正常路径 WS agent_status_changed 也会回写同一份缓存，两者形状一致；
// 无 monitor 事件（纯记录态）时乐观补丁保证徽标立即消失
export function useMarkAgentSeen() {
  const queryClient = useOptionalQueryClient()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { t } = useTranslation()
  return useCallback(
    async (paneIds: string[]) => {
      const ids = [...new Set(paneIds.filter(Boolean))]
      if (!ids.length) return
      const idSet = new Set(ids)
      try {
        const result = await api.panes.markSeen(ids)
        if (!result?.marked) return
        // paneId = <hostId>:%n，host 前缀即缓存 key 的 hostId
        const hostIds = [...new Set(ids.map((id) => id.split(':')[0]).filter(Boolean))]
        for (const hostId of hostIds) {
          queryClient?.setQueryData<Session[]>(['sessions', hostId], (sessions) =>
            sessions?.map((session) => {
              if (!session.agents?.some((agent) => idSet.has(agent.paneId) && agent.agentStatus === 'done'))
                return session
              const agents = session.agents.map((agent) =>
                idSet.has(agent.paneId) && agent.agentStatus === 'done'
                  ? { ...agent, agentStatus: 'idle' as const }
                  : agent,
              )
              return { ...session, agents, agentSummary: summarizeAgentStates(agents) }
            }),
          )
          for (const query of queryClient?.getQueryCache?.()?.findAll({ queryKey: ['session-snapshot', hostId] }) || [])
            queryClient?.setQueryData(query.queryKey, (snapshot: any) =>
              snapshot?.panes?.length
                ? {
                    ...snapshot,
                    panes: snapshot.panes.map((pane: any) =>
                      idSet.has(pane.id) && pane.agentStatus === 'done' ? { ...pane, agentStatus: 'idle' } : pane,
                    ),
                  }
                : snapshot,
            )
        }
        pushToast({ type: 'success', message: t('agent.markedSeen', { count: result.marked }) })
      } catch (err) {
        pushToast({ type: 'error', message: err instanceof Error ? err.message : t('agent.markSeenFailed') })
      }
    },
    [queryClient, pushToast, t],
  )
}
