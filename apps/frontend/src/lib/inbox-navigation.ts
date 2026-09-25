import type { QueryClient } from '@tanstack/react-query'
import { api } from './api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { InboxMessageRoute } from '@/types'

// 跨 window 选 pane 的唯一正确顺序（与 MobileDrawer.handleSelectPane 同链）：
// 先 select-window 再 select-pane，顺序不能颠倒；最后回填 snapshot cache + activePane
export async function selectPaneInSession(options: {
  hostId: string
  sessionId: string
  pane: { id: string; windowId?: string }
  activeWindowId?: string | null
  queryClient: QueryClient | null
}) {
  const { hostId, sessionId, pane, activeWindowId, queryClient } = options
  if (pane.windowId && pane.windowId !== activeWindowId) await api.windows.select(hostId, sessionId, pane.windowId)
  await api.panes.select(pane.id)
  const nextSnapshot = await api.snapshot.get(hostId, sessionId)
  queryClient?.setQueryData(['session-snapshot', hostId, sessionId], nextSnapshot)
  useConsoleStore.getState().setActivePane(pane.id)
}

export type InboxNavigateResult = 'pane' | 'session' | 'not-found' | 'no-target' | 'error'

async function findSessionByName(hostId: string, name: string) {
  const sessions = await api.sessions.list(hostId).catch(() => [] as any[])
  return (sessions as any[]).find((item) => item?.name === name) || null
}

// inbox 消息 route → 真实导航：先 setActiveHost/setActiveSession，再走 selectPaneInSession。
// route 缺 sessionName 时按 paneId 前缀解析 host 并在该 host 全部 session 内查 pane，
// 绝不跨 host 误选相同 %N（spec：查不到留在 inbox）
export async function navigateInboxRoute(
  route: InboxMessageRoute,
  queryClient: QueryClient | null,
): Promise<InboxNavigateResult> {
  const paneHost = route.paneId?.includes(':') ? route.paneId.split(':')[0] : ''
  const hostId = route.hostId || paneHost || useConsoleStore.getState().activeHostId || ''
  if (!hostId) return 'no-target'
  if (paneHost && route.hostId && paneHost !== route.hostId) return 'not-found'
  const paneKey = route.paneId || (route.tmuxPaneId ? `${hostId}:${route.tmuxPaneId}` : '')

  const activate = (sessionId: string) => {
    const state = useConsoleStore.getState()
    if (state.activeHostId !== hostId) state.setActiveHost(hostId)
    if (state.activeSessionId !== sessionId) state.setActiveSession(sessionId)
  }

  if (!paneKey) {
    if (!route.sessionName) return 'no-target'
    const session = await findSessionByName(hostId, route.sessionName)
    if (!session?.id) return 'not-found'
    activate(session.id)
    return 'session'
  }

  let sessionIds: string[]
  if (route.sessionName) {
    const session = await findSessionByName(hostId, route.sessionName)
    if (!session?.id) return 'not-found'
    sessionIds = [session.id]
  } else {
    const sessions = await api.sessions.list(hostId).catch(() => [] as any[])
    const state = useConsoleStore.getState()
    sessionIds = (sessions as any[]).map((item) => item.id).filter(Boolean)
    // 优先在当前 session 内命中，找不到再查同 host 其它 session
    if (state.activeHostId === hostId && state.activeSessionId && sessionIds.includes(state.activeSessionId))
      sessionIds = [state.activeSessionId, ...sessionIds.filter((id) => id !== state.activeSessionId)]
  }
  for (const sessionId of sessionIds) {
    const snapshot = await api.snapshot.get(hostId, sessionId).catch(() => null)
    const panes = (snapshot?.panes || []) as any[]
    const pane = panes.find((item) => item.id === paneKey || (route.tmuxPaneId && item.tmuxPaneId === route.tmuxPaneId))
    if (!pane) continue
    activate(sessionId)
    const activeWindowId = snapshot?.activeWindowId || snapshot?.windows?.find?.((item: any) => item.active)?.id || null
    try {
      await selectPaneInSession({ hostId, sessionId, pane, activeWindowId, queryClient })
    } catch {
      return 'error'
    }
    return 'pane'
  }
  return 'not-found'
}
