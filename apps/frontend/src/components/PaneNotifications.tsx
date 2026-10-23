'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from '@/i18n'
import { Chip } from './Chip'
import { usePreferences } from '@/hooks/usePreferences'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { buildSessionId, parseSessionName } from '@/lib/session-id'
import { mergeAgentPaneEvent, removeAgentPaneEvent, summarizeAgentStates } from '@/lib/agent-status'
import { markAgentNotificationsRead, syncAgentPush, enableAgentPush } from '@/lib/agent-push'
import { api, type AgentNotificationRecord } from '@/lib/api'
import type { AgentPaneState, Pane, Session, SessionSnapshot } from '@/types'
import { subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { AgentFeedClient, isAgentStateFrame, type AgentFeedUpdate } from '@/lib/agent-feed'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useAgentSeen } from '@/hooks/useAgentSeen'
import { useHosts } from '@/hooks/useApi'
import { FiAlertCircle, FiBell, FiBellOff, FiCheckCircle, FiX } from 'react-icons/fi'

interface NotificationItem {
  id: string
  paneId: string
  paneName: string
  hostId: string
  sessionId: string
  status: 'blocked' | 'done' | 'permission_required' | 'needs_input' | 'failed' | 'ended' | 'disconnected'
  title?: string
  message: string
  timestamp: string
}
type TranslateFn = ReturnType<typeof useTranslation>['t']
function sanitizeNotificationMessage(value: string) {
  return (
    value
      // 剔除 ANSI 转义序列：这里故意匹配 ESC 控制字符
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/(?:~|\/)[^\s,;)]{2,}/g, '[path]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
  )
}
function getAgentNotificationStatus(pane: AgentPaneState): NotificationItem['status'] | null {
  if (pane.phase === 'permission_required' || pane.lastEvent === 'permission_required') return 'permission_required'
  if (pane.phase === 'needs_input' || pane.lastEvent === 'question_required') return 'needs_input'
  if (pane.phase === 'failed' || pane.lastEvent === 'failed') return 'failed'
  if (pane.phase === 'ended' || pane.lastEvent === 'ended') return 'ended'
  if (pane.phase === 'disconnected' || pane.lastEvent === 'disconnected') return 'disconnected'
  if (pane.lastEvent === 'completed' || pane.agentStatus === 'done') return 'done'
  if (pane.agentStatus === 'blocked') return 'blocked'
  return null
}
function getAgentNotificationMessage(
  status: NotificationItem['status'],
  agent: string,
  session: string,
  t: TranslateFn,
) {
  const key: Record<NotificationItem['status'], Parameters<TranslateFn>[0]> = {
    blocked: 'agent.notification.blocked',
    done: 'agent.notification.done',
    permission_required: 'agent.notification.permission',
    needs_input: 'agent.notification.question',
    failed: 'agent.notification.failed',
    ended: 'agent.notification.ended',
    disconnected: 'agent.notification.disconnected',
  }
  return t(key[status], { agent, session })
}
function isAgentAttentionStatus(status: NotificationItem['status']) {
  return status !== 'done'
}
const notificationsStorageKey = 'tmuxgo-pane-notifications'
const mutedPanesStorageKey = 'tmuxgo-muted-pane-notifications'
const notificationBubblePositionKey = 'tmuxgo-notification-bubble-position'
const notificationBubbleSize = 36
const notificationBubbleDragThreshold = 8
function clampNotificationBubblePosition(x: number, y: number) {
  const margin = 8
  return {
    x: Math.min(Math.max(margin, window.innerWidth - notificationBubbleSize - margin), Math.max(margin, x)),
    y: Math.min(Math.max(margin, window.innerHeight - notificationBubbleSize - margin), Math.max(margin, y)),
  }
}
function readNotificationBubblePosition() {
  try {
    const raw = JSON.parse(localStorage.getItem(notificationBubblePositionKey) || 'null')
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null
    return { x: raw.x, y: raw.y }
  } catch {
    return null
  }
}
function readStoredNotifications() {
  try {
    const raw = JSON.parse(localStorage.getItem(notificationsStorageKey) || '[]')
    return Array.isArray(raw)
      ? raw
          .filter(
            (item): item is NotificationItem =>
              item &&
              typeof item.id === 'string' &&
              typeof item.paneId === 'string' &&
              typeof item.timestamp === 'string',
          )
          .slice(0, 100)
      : []
  } catch {
    return []
  }
}
function readMutedPanes() {
  try {
    const raw = JSON.parse(localStorage.getItem(mutedPanesStorageKey) || '[]')
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
function toNotificationItem(record: AgentNotificationRecord, t: TranslateFn): NotificationItem | null {
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.hostId !== 'string' ||
    typeof record.sessionName !== 'string' ||
    typeof record.paneId !== 'string' ||
    typeof record.agent !== 'string'
  )
    return null
  const status = record.status
  if (!['blocked', 'done', 'permission_required', 'needs_input', 'failed', 'ended', 'disconnected'].includes(status))
    return null
  return {
    id: record.id,
    paneId: record.paneId,
    paneName: record.agent,
    hostId: record.hostId,
    sessionId: buildSessionId(record.hostId, record.sessionName),
    status,
    title: record.title,
    message:
      sanitizeNotificationMessage(record.message) ||
      getAgentNotificationMessage(status, record.agent, record.sessionName, t),
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
  }
}
export function PaneNotifications() {
  const [notifications, setNotifications] = useState<NotificationItem[]>(readStoredNotifications)
  const notificationsRef = useRef(notifications)
  const [visibleIds, setVisibleIds] = useState<string[]>([])
  const [centerOpen, setCenterOpen] = useState(false)
  const [notificationBubblePosition, setNotificationBubblePosition] = useState<{ x: number; y: number } | null>(null)
  const notificationBubbleDragRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    dragging: false,
    moved: false,
  })
  const removedAgentKeysRef = useRef(new Set<string>())
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const queryClient = useOptionalQueryClient()
  // done 停驻 800ms 后显式 ack（服务端 agent_seen 分支），与快照 markSeen 双清同一徽标
  useAgentSeen()
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const setActivePane = useConsoleStore((state) => state.setActivePane)
  // 稳定化：这三个动作被事件订阅 effect 与 openNotification 依赖，身份必须跨 render 稳定，
  // 否则每次 render 都会重挂 service worker / stream 监听
  const updateNotifications = useCallback((update: (current: NotificationItem[]) => NotificationItem[]) => {
    setNotifications((current) => {
      const next = update(current).slice(0, 100)
      notificationsRef.current = next
      localStorage.setItem(notificationsStorageKey, JSON.stringify(next))
      return next
    })
  }, [])
  const dismissNotification = useCallback(
    (id: string) => {
      setVisibleIds((current) => current.filter((item) => item !== id))
      updateNotifications((current) => current.filter((item) => item.id !== id))
      void markAgentNotificationsRead([id])
    },
    [updateNotifications],
  )
  const updateSnapshot = useCallback(
    (hostId: string, sessionName: string, pane: AgentPaneState) => {
      const sessionId = buildSessionId(hostId, sessionName)
      queryClient?.setQueryData<SessionSnapshot>(['session-snapshot', hostId, sessionId], (snapshot) =>
        snapshot
          ? { ...snapshot, panes: mergeAgentPaneEvent(Array.isArray(snapshot.panes) ? snapshot.panes : [], pane) }
          : snapshot,
      )
    },
    [queryClient],
  )
  const updateSession = useCallback(
    (hostId: string, sessionName: string, pane: AgentPaneState) => {
      const sessionId = buildSessionId(hostId, sessionName)
      queryClient?.setQueryData<Session[]>(['sessions', hostId], (sessions) =>
        sessions?.map((session) => {
          if (session.id !== sessionId) return session
          const agents = [...(session.agents || []).filter((item) => item.paneId !== pane.paneId), pane]
          return { ...session, agents, agentSummary: summarizeAgentStates(agents) }
        }),
      )
    },
    [queryClient],
  )
  const updateAgentCache = useCallback(
    (hostId: string, sessionName: string, pane: AgentPaneState) => {
      updateSnapshot(hostId, sessionName, pane)
      updateSession(hostId, sessionName, pane)
    },
    [updateSnapshot, updateSession],
  )
  const removeAgentCache = useCallback(
    (hostId: string, sessionName: string, paneId: string) => {
      const sessionId = buildSessionId(hostId, sessionName)
      queryClient?.setQueryData<SessionSnapshot>(['session-snapshot', hostId, sessionId], (snapshot) =>
        snapshot
          ? { ...snapshot, panes: removeAgentPaneEvent(Array.isArray(snapshot.panes) ? snapshot.panes : [], paneId) }
          : snapshot,
      )
      queryClient?.setQueryData<Session[]>(['sessions', hostId], (sessions) =>
        sessions?.map((session) => {
          if (session.id !== sessionId) return session
          const agents = (session.agents || []).filter((pane) => pane.paneId !== paneId)
          return { ...session, agents, agentSummary: summarizeAgentStates(agents) }
        }),
      )
    },
    [queryClient],
  )
  const updateSnapshotCache = useCallback(
    (hostId: string, agents: AgentPaneState[]) => {
      const bySession = new Map<string, AgentPaneState[]>()
      for (const pane of agents) {
        const sessionAgents = bySession.get(pane.sessionName) || []
        sessionAgents.push(pane)
        bySession.set(pane.sessionName, sessionAgents)
        removedAgentKeysRef.current.delete(`${hostId}:${pane.paneId}`)
      }
      const snapshotQueries = queryClient?.getQueryCache?.()?.findAll({ queryKey: ['session-snapshot', hostId] }) || []
      for (const query of snapshotQueries) {
        const sessionName = parseSessionName(hostId, String(query.queryKey[2] || ''))
        const agentByPane = new Map((bySession.get(sessionName) || []).map((pane) => [pane.paneId, pane]))
        queryClient?.setQueryData<SessionSnapshot>(query.queryKey, (snapshot) =>
          snapshot
            ? {
                ...snapshot,
                panes: Array.isArray(snapshot.panes)
                  ? snapshot.panes.map((pane: Pane) => {
                      const incoming = agentByPane.get(pane.id)
                      return incoming
                        ? mergeAgentPaneEvent([pane], incoming, true)[0]
                        : removeAgentPaneEvent([pane], pane.id)[0]
                    })
                  : snapshot.panes,
              }
            : snapshot,
        )
      }
      for (const pane of agents) {
        updateSnapshot(hostId, pane.sessionName, pane)
      }
      queryClient?.setQueryData<Session[]>(['sessions', hostId], (sessions) =>
        sessions?.map((session) => {
          const sessionAgents = bySession.get(session.name) || []
          return { ...session, agents: sessionAgents, agentSummary: summarizeAgentStates(sessionAgents) }
        }),
      )
    },
    [queryClient, updateSnapshot],
  )

  const clearAll = () => {
    const ids = notificationsRef.current.map((notification) => notification.id)
    setVisibleIds([])
    updateNotifications(() => [])
    if (ids.length) void markAgentNotificationsRead(ids)
  }
  useEffect(() => {
    if (!preferences.agentNotificationsEnabled) return
    let active = true
    void syncAgentPush().then((records) => {
      if (!active || !records.length) return
      const incoming = records
        .map((record) => toNotificationItem(record, t))
        .filter((item): item is NotificationItem => !!item)
      if (!incoming.length) return
      updateNotifications((current) => {
        const ids = new Set(current.map((item) => item.id))
        return [...incoming.filter((item) => !ids.has(item.id)), ...current]
      })
    })
    return () => {
      active = false
    }
  }, [preferences.agentNotificationsEnabled, t, updateNotifications])
  useEffect(() => {
    const saved = readNotificationBubblePosition()
    setNotificationBubblePosition(
      saved
        ? clampNotificationBubblePosition(saved.x, saved.y)
        : clampNotificationBubblePosition(
            window.innerWidth - notificationBubbleSize - 16,
            window.innerHeight - notificationBubbleSize - 112,
          ),
    )
    const handleResize = () =>
      setNotificationBubblePosition((current) =>
        current ? clampNotificationBubblePosition(current.x, current.y) : current,
      )
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [])
  const handleNotificationBubblePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!notificationBubblePosition || (event.pointerType === 'mouse' && event.button !== 0)) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    notificationBubbleDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: notificationBubblePosition.x,
      originY: notificationBubblePosition.y,
      dragging: true,
      moved: false,
    }
  }
  const handleNotificationBubblePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = notificationBubbleDragRef.current
    if (!state.dragging || state.pointerId !== event.pointerId) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.moved && Math.hypot(dx, dy) < notificationBubbleDragThreshold) return
    state.moved = true
    setNotificationBubblePosition(clampNotificationBubblePosition(state.originX + dx, state.originY + dy))
  }
  const handleNotificationBubblePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = notificationBubbleDragRef.current
    if (!state.dragging || state.pointerId !== event.pointerId) return
    state.dragging = false
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {}
    if (state.moved) {
      setNotificationBubblePosition((current) => {
        if (!current) return current
        const next = clampNotificationBubblePosition(current.x, current.y)
        localStorage.setItem(notificationBubblePositionKey, JSON.stringify(next))
        return next
      })
    }
  }
  const handleNotificationBubbleClick = () => {
    if (notificationBubbleDragRef.current.moved) {
      notificationBubbleDragRef.current.moved = false
      return
    }
    setCenterOpen((current) => !current)
  }
  const openNotification = useCallback(
    async (notification: NotificationItem) => {
      try {
        const key = ['session-snapshot', notification.hostId, notification.sessionId]
        const cached = queryClient?.getQueryData?.(key) as SessionSnapshot | undefined
        const snapshot = cached?.panes?.some?.((pane: Pane) => pane.id === notification.paneId)
          ? cached
          : await api.snapshot.get(notification.hostId, notification.sessionId)
        const targetPane = snapshot?.panes?.find?.((pane: Pane) => pane.id === notification.paneId)
        if (!targetPane) return
        if (targetPane.windowId && targetPane.windowId !== snapshot.activeWindowId)
          await api.windows.select(notification.hostId, notification.sessionId, targetPane.windowId)
        await api.panes.select(notification.paneId)
        const nextSnapshot = await api.snapshot.get(notification.hostId, notification.sessionId)
        queryClient?.setQueryData(key, nextSnapshot)
        if (useConsoleStore.getState().activeHostId !== notification.hostId) setActiveHost(notification.hostId)
        setActiveSession(notification.sessionId)
        setActivePane(notification.paneId)
        dismissNotification(notification.id)
        setCenterOpen(false)
      } catch {}
    },
    [dismissNotification, queryClient, setActiveHost, setActivePane, setActiveSession],
  )
  useEffect(() => {
    if (!preferences.agentNotificationsEnabled) {
      setVisibleIds([])
      setCenterOpen(false)
    }
  }, [preferences.agentNotificationsEnabled])
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const detail = event.data as {
        type?: string
        id?: string
        hostId?: string
        sessionName?: string
        paneId?: string
        agent?: string
        status?: string
        title?: string
        message?: string
        timestamp?: string
      }
      if (
        detail?.type !== 'tmuxgo-agent-notification-click' ||
        typeof detail.hostId !== 'string' ||
        typeof detail.sessionName !== 'string' ||
        typeof detail.paneId !== 'string'
      )
        return
      const status =
        detail.status &&
        ['blocked', 'done', 'permission_required', 'needs_input', 'failed', 'ended', 'disconnected'].includes(
          detail.status,
        )
          ? (detail.status as NotificationItem['status'])
          : 'blocked'
      const agent = typeof detail.agent === 'string' && detail.agent ? detail.agent : 'agent'
      const notification: NotificationItem = {
        id: typeof detail.id === 'string' ? detail.id : `${detail.hostId}:${detail.paneId}:push`,
        paneId: detail.paneId,
        paneName: agent,
        hostId: detail.hostId,
        sessionId: buildSessionId(detail.hostId, detail.sessionName),
        status,
        title: typeof detail.title === 'string' ? detail.title : undefined,
        message:
          sanitizeNotificationMessage(detail.message || '') ||
          getAgentNotificationMessage(status, agent, detail.sessionName, t),
        timestamp: typeof detail.timestamp === 'string' ? detail.timestamp : new Date().toISOString(),
      }
      void openNotification(notification)
    }
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage)
    return () => navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage)
  }, [openNotification, t])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const hostId = params.get('hostId')
    const sessionName = params.get('sessionName')
    const paneId = params.get('paneId')
    const notificationId = params.get('notificationId')
    if (!hostId || !sessionName || !paneId) return
    const notification: NotificationItem = {
      id: notificationId || `${hostId}:${paneId}:push`,
      paneId,
      paneName: 'agent',
      hostId,
      sessionId: buildSessionId(hostId, sessionName),
      status: 'blocked',
      message: getAgentNotificationMessage('blocked', 'agent', sessionName, t),
      timestamp: new Date().toISOString(),
    }
    void openNotification(notification)
    const url = new URL(window.location.href)
    url.searchParams.delete('hostId')
    url.searchParams.delete('sessionName')
    url.searchParams.delete('paneId')
    url.searchParams.delete('notificationId')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }, [openNotification, t])
  useEffect(() => {
    if (!preferences.agentNotificationsEnabled || !visibleIds.length) return
    const timer = window.setTimeout(() => setVisibleIds([]), preferences.agentNotificationDurationMs)
    return () => window.clearTimeout(timer)
  }, [preferences.agentNotificationDurationMs, preferences.agentNotificationsEnabled, visibleIds])
  useEffect(() => {
    const toggleCenter = () => setCenterOpen((current) => !current)
    window.addEventListener('tmuxgo-toggle-notifications', toggleCenter)
    return () => window.removeEventListener('tmuxgo-toggle-notifications', toggleCenter)
  }, [])
  useEffect(() => {
    const publishNotification = (hostId: string, sessionName: string, pane: AgentPaneState, eventId?: string) => {
      if (!preferences.agentNotificationsEnabled || readMutedPanes().includes(pane.paneId)) return
      const status = getAgentNotificationStatus(pane)
      if (!status) return
      const sessionId = buildSessionId(hostId, sessionName)
      const id = eventId || pane.eventId || `${pane.paneId}:${pane.revision}:${status}`
      const message =
        sanitizeNotificationMessage(pane.message || '') ||
        getAgentNotificationMessage(status, pane.agent, sessionName, t)
      const notification: NotificationItem = {
        id,
        paneId: pane.paneId,
        paneName: pane.agent,
        hostId,
        sessionId,
        status,
        title: pane.display?.title,
        message,
        timestamp: new Date().toISOString(),
      }
      const isNew = !notificationsRef.current.some((item) => item.id === id)
      if (!isNew) return
      updateNotifications((current) => [notification, ...current.filter((item) => item.id !== id)])
      setVisibleIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 8))
      if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
        const browserNotification = new Notification(notification.title || t('notification.title'), {
          body: message,
          tag: id,
        })
        browserNotification.onclick = () => {
          window.focus()
          browserNotification.close()
          void openNotification(notification)
        }
      }
    }
    const handleAgentStatus = (detail: {
      hostId: string
      sessionName: string
      pane: AgentPaneState
      initial?: boolean
      eventId?: string
    }) => {
      if (!detail?.hostId || !detail.sessionName || !detail.pane) return
      removedAgentKeysRef.current.delete(`${detail.hostId}:${detail.pane.paneId}`)
      updateAgentCache(detail.hostId, detail.sessionName, detail.pane)
      if (!detail.eventId && !detail.initial) publishNotification(detail.hostId, detail.sessionName, detail.pane)
    }
    const handleAgentSnapshot = (detail: { hostId: string; initial?: boolean; agents: AgentPaneState[] }) => {
      if (!detail?.hostId || !Array.isArray(detail.agents)) return
      updateSnapshotCache(detail.hostId, detail.agents)
    }
    const handleAgentRemoved = (detail: { hostId: string; sessionName: string; paneId: string }) => {
      if (!detail?.hostId || !detail.sessionName || !detail.paneId) return
      removedAgentKeysRef.current.add(`${detail.hostId}:${detail.paneId}`)
      removeAgentCache(detail.hostId, detail.sessionName, detail.paneId)
    }
    const handleAgentNotification = (detail: {
      hostId: string
      sessionName: string
      pane: AgentPaneState
      eventId?: string
      initial?: boolean
    }) => {
      if (!detail?.hostId || !detail.sessionName || !detail.pane || detail.initial) return
      if (!removedAgentKeysRef.current.has(`${detail.hostId}:${detail.pane.paneId}`))
        updateAgentCache(detail.hostId, detail.sessionName, detail.pane)
      publishNotification(detail.hostId, detail.sessionName, detail.pane, detail.eventId)
    }
    const unsubs = [
      subscribeStreamEvent(STREAM_EVENT.agentStatus, handleAgentStatus),
      subscribeStreamEvent(STREAM_EVENT.agentStatusSnapshot, handleAgentSnapshot),
      subscribeStreamEvent(STREAM_EVENT.agentStatusRemoved, handleAgentRemoved),
      subscribeStreamEvent(STREAM_EVENT.agentNotification, handleAgentNotification),
    ]
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [
    openNotification,
    preferences.agentNotificationsEnabled,
    queryClient,
    removeAgentCache,
    t,
    updateAgentCache,
    updateNotifications,
    updateSnapshotCache,
  ])
  // v1 推式订阅：每个 host 一条订阅（hostId 是订阅意图的稳定键，subId 会随重连变）。
  // 帧语义交给 AgentFeedClient 判 seq/断号；视图层只处理 full（整 host 替换）与
  // delta（按 pane 合并、stateSeq 小者丢），pulse 只更新水位不动缓存
  const { send: sendStreamFrame, isSocketReady } = useWebSocket()
  const { data: hosts } = useHosts()
  const hostIds = useMemo(
    () =>
      (hosts || [])
        .map((host) => host.id)
        .filter(Boolean)
        .sort(),
    [hosts],
  )
  const hostIdsRef = useRef(hostIds)
  hostIdsRef.current = hostIds
  const feedPortRef = useRef<{
    update: (update: AgentFeedUpdate, hostId: string) => void
    degraded: (hostId: string) => void
  } | null>(null)
  const feedRetryRef = useRef(new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }>())
  // 老网关不支持 v1 帧：一旦协商失败就永久走 legacy/REST，不再重试也不刷错
  const feedUnsupportedRef = useRef(false)
  const sendFrameRef = useRef(sendStreamFrame)
  sendFrameRef.current = sendStreamFrame
  const feedClientRef = useRef<AgentFeedClient | null>(null)
  if (!feedClientRef.current) {
    feedClientRef.current = new AgentFeedClient({
      // socket 未就绪时 send 返回 false，AgentFeedClient 会撤掉占位订阅等下次重试
      send: (frame) => sendFrameRef.current(frame),
      onUpdate: (update) => feedPortRef.current?.update(update, update.hostId),
      onDegraded: (hostId) => feedPortRef.current?.degraded(hostId),
    })
  }
  feedPortRef.current = {
    update: (update, hostId) => {
      if (update.mode === 'full') {
        // full 是整 host 替换：未出现的 pane 视为没有 agent 状态，交给 updateSnapshotCache 清理
        updateSnapshotCache(hostId, update.changed)
      } else {
        for (const pane of update.changed) {
          removedAgentKeysRef.current.delete(`${hostId}:${pane.paneId}`)
          updateAgentCache(hostId, pane.sessionName, pane)
        }
      }
      for (const removed of update.removed) {
        removedAgentKeysRef.current.add(`${hostId}:${removed.paneId}`)
        if (removed.sessionName) removeAgentCache(hostId, removed.sessionName, removed.paneId)
      }
      if (update.mode === 'full') feedRetryRef.current.delete(hostId)
    },
    degraded: (hostId) => {
      // 断号重同步彻底失败：回落到 REST 快照，并按指数退避重开订阅（服务端 seq 从头算）
      void queryClient?.invalidateQueries({ queryKey: ['sessions', hostId] })
      void queryClient?.invalidateQueries({ queryKey: ['session-snapshot', hostId] })
      const state = feedRetryRef.current.get(hostId) || { attempts: 0, timer: null }
      state.attempts += 1
      if (state.timer) clearTimeout(state.timer)
      const delay = Math.min(5000 * 2 ** (state.attempts - 1), 60000)
      state.timer = setTimeout(() => {
        state.timer = null
        feedClientRef.current?.subscribe(hostId)
      }, delay)
      feedRetryRef.current.set(hostId, state)
    },
  }
  useEffect(() => {
    const client = feedClientRef.current
    if (!client || feedUnsupportedRef.current) return
    if (!isSocketReady) return
    for (const hostId of hostIds) client.subscribe(hostId)
    for (const hostId of client.hosts()) if (!hostIds.includes(hostId)) client.unsubscribe(hostId)
  }, [hostIds, isSocketReady])
  useEffect(() => {
    const client = feedClientRef.current
    if (!client) return
    const unsubscribe = subscribeStreamEvent<unknown>(STREAM_EVENT.agentState, (detail) => {
      if (!isAgentStateFrame(detail)) return
      client.handleFrame(detail)
    })
    // 重连后服务端订阅已消失：本地 seq 基线必须清零再重新订阅
    const onReconnected = () => {
      client.reset()
      if (feedUnsupportedRef.current) return
      for (const hostId of hostIdsRef.current) client.subscribe(hostId)
    }
    const unsubscribeReconnect = subscribeStreamEvent(STREAM_EVENT.reconnected, onReconnected)
    // 能力协商失败：退回 legacy 帧（老网关本来就双发），清掉订阅与退避计时器
    const unsubscribeUnsupported = subscribeStreamEvent(STREAM_EVENT.agentFeedUnsupported, () => {
      if (feedUnsupportedRef.current) return
      feedUnsupportedRef.current = true
      client.reset()
      for (const state of feedRetryRef.current.values()) if (state.timer) clearTimeout(state.timer)
      feedRetryRef.current.clear()
    })
    return () => {
      unsubscribe()
      unsubscribeReconnect()
      unsubscribeUnsupported()
    }
  }, [])
  useEffect(() => {
    const retries = feedRetryRef.current
    const client = feedClientRef.current
    return () => {
      for (const state of retries.values()) if (state.timer) clearTimeout(state.timer)
      retries.clear()
      // 组件卸载但 socket 仍在（布局切换）：先退订，别让服务端继续按 host 推帧
      for (const hostId of client?.hosts() || []) client?.unsubscribe(hostId)
      client?.reset()
    }
  }, [])
  const displayed = centerOpen
    ? notifications
    : notifications.filter((notification) => visibleIds.includes(notification.id))
  if (!preferences.agentNotificationsEnabled) return null
  return (
    <>
      {notifications.length > 0 && notificationBubblePosition && (
        <button
          type="button"
          onPointerDown={handleNotificationBubblePointerDown}
          onPointerMove={handleNotificationBubblePointerMove}
          onPointerUp={handleNotificationBubblePointerUp}
          onPointerCancel={handleNotificationBubblePointerUp}
          onClick={handleNotificationBubbleClick}
          onContextMenu={(event) => event.preventDefault()}
          aria-label={t('notification.title')}
          title={t('notification.title')}
          className="tmuxgo-glass pointer-events-auto fixed z-50 flex h-9 w-9 touch-none select-none items-center justify-center rounded-full border border-[var(--line)] bg-bg-1 text-text-2 lg:hidden"
          style={{ left: notificationBubblePosition.x, top: notificationBubblePosition.y }}
        >
          <FiBell aria-hidden="true" />
        </button>
      )}
      {notifications.length > 0 && (centerOpen || displayed.length > 0) && (
        <div className="pointer-events-auto fixed bottom-28 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] lg:bottom-16">
          <div className="overflow-hidden rounded-apple border border-[var(--line)] bg-bg-1">
            <div className="flex items-center justify-between border-b border-[var(--line)] p-2">
              <button onClick={() => setCenterOpen((current) => !current)} className="text-xs text-text-2">
                {t('notification.title')} {notifications.length ? `(${notifications.length})` : ''}
              </button>
              {notifications.length > 0 && (
                <button onClick={clearAll} className="text-xs text-text-3 hover:text-text-1">
                  {t('notification.clearAll')}
                </button>
              )}
            </div>
            <div className="tmuxgo-scrollbar max-h-72 overflow-x-hidden overflow-y-auto">
              {!displayed.length && (
                <div className="p-4 text-center text-sm text-text-3">{t('notification.empty')}</div>
              )}
              {displayed.slice(0, centerOpen ? 100 : 5).map((notification) => {
                const attention = isAgentAttentionStatus(notification.status)
                return (
                  <div key={notification.id} className="flex border-b border-[var(--line)] hover:bg-bg-2">
                    <button
                      onClick={() => void openNotification(notification)}
                      className="min-w-0 flex-1 p-2 text-left"
                    >
                      <span
                        className={`flex items-center gap-1.5 text-xs ${attention ? 'text-danger' : 'text-accent-2'}`}
                      >
                        {attention ? <FiAlertCircle aria-hidden="true" /> : <FiCheckCircle aria-hidden="true" />}
                        {notification.paneName}
                      </span>
                      <span className="mt-1 block text-sm text-text-1">{notification.message}</span>
                      <span className="mt-1 block text-caption text-text-3">
                        {new Date(notification.timestamp).toLocaleString()}
                      </span>
                    </button>
                    <button
                      onClick={() => dismissNotification(notification.id)}
                      className="flex w-9 shrink-0 items-start justify-center pt-2 text-text-3 hover:text-text-1"
                      aria-label={t('common.close')}
                    >
                      <FiX aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
export function WatchButton({ paneId, compact = false }: { paneId: string; compact?: boolean }) {
  const [isWatched, setIsWatched] = useState(true)
  const { t } = useTranslation()
  useEffect(() => {
    setIsWatched(!!paneId && !readMutedPanes().includes(paneId))
  }, [paneId])
  const toggle = () => {
    if (!paneId) return
    const muted = readMutedPanes()
    const updated = isWatched ? [...muted.filter((id) => id !== paneId), paneId] : muted.filter((id) => id !== paneId)
    localStorage.setItem(mutedPanesStorageKey, JSON.stringify(updated))
    setIsWatched(!isWatched)
    window.dispatchEvent(new CustomEvent('tmuxgo-watched-panes-change', { detail: { paneId, watched: !isWatched } }))
    if (!isWatched && 'Notification' in window) {
      if (Notification.permission === 'default')
        void Notification.requestPermission().then((permission) => {
          if (permission === 'granted') void enableAgentPush()
        })
      else if (Notification.permission === 'granted') void enableAgentPush()
    }
  }
  const unavailable = !paneId
  const label = unavailable ? t('notification.watch') : isWatched ? t('notification.unwatch') : t('notification.watch')
  return (
    <Chip
      onClick={toggle}
      disabled={unavailable}
      aria-pressed={isWatched}
      aria-label={label}
      title={label}
      tone={isWatched ? 'accent' : 'default'}
      className={`flex items-center ${compact ? 'px-[10px]' : 'w-full justify-center gap-2 px-[10px] py-[5px]'} ${unavailable ? 'cursor-not-allowed' : ''}`}
    >
      {isWatched ? <FiBell aria-hidden="true" /> : <FiBellOff aria-hidden="true" />}
      {!compact && <span>{label}</span>}
    </Chip>
  )
}
