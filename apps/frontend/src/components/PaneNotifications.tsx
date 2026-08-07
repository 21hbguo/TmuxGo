'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from '@/i18n'
import { Chip } from './Chip'
import { usePreferences } from '@/hooks/usePreferences'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { buildSessionId, parseSessionName } from '@/lib/session-id'
import { mergeAgentPaneEvent, removeAgentPaneEvent, summarizeAgentStates } from '@/lib/agent-status'
import { api } from '@/lib/api'
import type { AgentPaneState, Session } from '@/types'
import { FiAlertCircle, FiBell, FiBellOff, FiCheckCircle, FiX } from 'react-icons/fi'

interface NotificationItem {
  id: string
  paneId: string
  paneName: string
  hostId: string
  sessionId: string
  status: 'blocked' | 'done' | 'permission_required' | 'needs_input' | 'failed' | 'ended' | 'disconnected'
  message: string
  timestamp: string
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
function getAgentNotificationMessage(status: NotificationItem['status'], agent: string, session: string, t: (key: string, params?: Record<string, string>) => string) {
  const key: Record<NotificationItem['status'], string> = {
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
    return Array.isArray(raw) ? raw.filter((item): item is NotificationItem => item && typeof item.id === 'string' && typeof item.paneId === 'string' && typeof item.timestamp === 'string').slice(0, 100) : []
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
export function PaneNotifications() {
  const [notifications, setNotifications] = useState<NotificationItem[]>(readStoredNotifications)
  const notificationsRef = useRef(notifications)
  const [visibleIds, setVisibleIds] = useState<string[]>([])
  const [centerOpen, setCenterOpen] = useState(false)
  const [notificationBubblePosition, setNotificationBubblePosition] = useState<{ x: number; y: number } | null>(null)
  const notificationBubbleDragRef = useRef({ pointerId: -1, startX: 0, startY: 0, originX: 0, originY: 0, dragging: false, moved: false })
  const removedAgentKeysRef = useRef(new Set<string>())
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const queryClient = useOptionalQueryClient()
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const setActivePane = useConsoleStore((state) => state.setActivePane)
  const updateNotifications = (update: (current: NotificationItem[]) => NotificationItem[]) => {
    setNotifications((current) => {
      const next = update(current).slice(0, 100)
      notificationsRef.current = next
      localStorage.setItem(notificationsStorageKey, JSON.stringify(next))
      return next
    })
  }
  const dismissNotification = (id: string) => {
    setVisibleIds((current) => current.filter((item) => item !== id))
    updateNotifications((current) => current.filter((item) => item.id !== id))
  }
  const clearAll = () => {
    setVisibleIds([])
    updateNotifications(() => [])
  }
  useEffect(() => {
    const saved = readNotificationBubblePosition()
    setNotificationBubblePosition(saved ? clampNotificationBubblePosition(saved.x, saved.y) : clampNotificationBubblePosition(window.innerWidth - notificationBubbleSize - 16, window.innerHeight - notificationBubbleSize - 112))
    const handleResize = () => setNotificationBubblePosition((current) => current ? clampNotificationBubblePosition(current.x, current.y) : current)
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [])
  const handleNotificationBubblePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!notificationBubblePosition || event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    notificationBubbleDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: notificationBubblePosition.x, originY: notificationBubblePosition.y, dragging: true, moved: false }
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
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {}
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
  const openNotification = async (notification: NotificationItem) => {
    try {
      const key = ['session-snapshot', notification.hostId, notification.sessionId]
      const cached = queryClient?.getQueryData?.(key) as any
      const snapshot = cached?.panes?.some?.((pane: any) => pane.id === notification.paneId) ? cached : await api.snapshot.get(notification.hostId, notification.sessionId)
      const targetPane = snapshot?.panes?.find?.((pane: any) => pane.id === notification.paneId)
      if (!targetPane) return
      if (targetPane.windowId && targetPane.windowId !== snapshot.activeWindowId) await api.windows.select(notification.hostId, notification.sessionId, targetPane.windowId)
      await api.panes.select(notification.paneId)
      const nextSnapshot = await api.snapshot.get(notification.hostId, notification.sessionId)
      queryClient?.setQueryData(key, nextSnapshot)
      if (useConsoleStore.getState().activeHostId !== notification.hostId) setActiveHost(notification.hostId)
      setActiveSession(notification.sessionId)
      setActivePane(notification.paneId)
      dismissNotification(notification.id)
      setCenterOpen(false)
    } catch {}
  }
  useEffect(() => {
    if (!preferences.agentNotificationsEnabled) {
      setVisibleIds([])
      setCenterOpen(false)
    }
  }, [preferences.agentNotificationsEnabled])
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
    const updateSnapshot = (hostId: string, sessionName: string, pane: AgentPaneState) => {
      const sessionId = buildSessionId(hostId, sessionName)
      queryClient?.setQueryData(['session-snapshot', hostId, sessionId], (snapshot: any) => snapshot ? { ...snapshot, panes: mergeAgentPaneEvent(Array.isArray(snapshot.panes) ? snapshot.panes : [], pane) } : snapshot)
    }
    const updateSession = (hostId: string, sessionName: string, pane: AgentPaneState) => {
      const sessionId = buildSessionId(hostId, sessionName)
      queryClient?.setQueryData<Session[]>(['sessions', hostId], (sessions) => sessions?.map((session) => {
        if (session.id !== sessionId) return session
        const agents = [...(session.agents || []).filter((item) => item.paneId !== pane.paneId), pane]
        return { ...session, agents, agentSummary: summarizeAgentStates(agents) }
      }))
    }
    const updateAgentCache = (hostId: string, sessionName: string, pane: AgentPaneState) => {
      updateSnapshot(hostId, sessionName, pane)
      updateSession(hostId, sessionName, pane)
    }
    const removeAgentCache = (hostId: string, sessionName: string, paneId: string) => {
      const sessionId = buildSessionId(hostId, sessionName)
      queryClient?.setQueryData(['session-snapshot', hostId, sessionId], (snapshot: any) => snapshot ? { ...snapshot, panes: removeAgentPaneEvent(Array.isArray(snapshot.panes) ? snapshot.panes : [], paneId) } : snapshot)
      queryClient?.setQueryData<Session[]>(['sessions', hostId], (sessions) => sessions?.map((session) => {
        if (session.id !== sessionId) return session
        const agents = (session.agents || []).filter((pane) => pane.paneId !== paneId)
        return { ...session, agents, agentSummary: summarizeAgentStates(agents) }
      }))
    }
    const updateSnapshotCache = (hostId: string, agents: AgentPaneState[]) => {
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
        queryClient?.setQueryData(query.queryKey, (snapshot: any) => snapshot ? { ...snapshot, panes: Array.isArray(snapshot.panes) ? snapshot.panes.map((pane: any) => {
          const incoming = agentByPane.get(pane.id)
          return incoming ? mergeAgentPaneEvent([pane], incoming, true)[0] : removeAgentPaneEvent([pane], pane.id)[0]
        }) : snapshot.panes } : snapshot)
      }
      for (const pane of agents) {
        updateSnapshot(hostId, pane.sessionName, pane)
      }
      queryClient?.setQueryData<Session[]>(['sessions', hostId], (sessions) => sessions?.map((session) => {
        const sessionAgents = bySession.get(session.name) || []
        return { ...session, agents: sessionAgents, agentSummary: summarizeAgentStates(sessionAgents) }
      }))
    }
    const publishNotification = (hostId: string, sessionName: string, pane: AgentPaneState, eventId?: string) => {
      if (!preferences.agentNotificationsEnabled || readMutedPanes().includes(pane.paneId)) return
      const status = getAgentNotificationStatus(pane)
      if (!status) return
      const sessionId = buildSessionId(hostId, sessionName)
      const id = eventId || pane.eventId || `${pane.paneId}:${pane.revision}:${status}`
      const message = getAgentNotificationMessage(status, pane.agent, sessionName, t)
      const notification: NotificationItem = { id, paneId: pane.paneId, paneName: pane.agent, hostId, sessionId, status, message, timestamp: new Date().toISOString() }
      const isNew = !notificationsRef.current.some((item) => item.id === id)
      if (!isNew) return
      updateNotifications((current) => [notification, ...current.filter((item) => item.id !== id)])
      setVisibleIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 8))
      if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
        const browserNotification = new Notification(t('notification.title'), { body: message, tag: id })
        browserNotification.onclick = () => {
          window.focus()
          browserNotification.close()
          void openNotification(notification)
        }
      }
    }
    const handleAgentStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; sessionName: string; pane: AgentPaneState; initial?: boolean; eventId?: string }>).detail
      if (!detail?.hostId || !detail.sessionName || !detail.pane) return
      removedAgentKeysRef.current.delete(`${detail.hostId}:${detail.pane.paneId}`)
      updateAgentCache(detail.hostId, detail.sessionName, detail.pane)
      if (!detail.eventId && !detail.initial) publishNotification(detail.hostId, detail.sessionName, detail.pane)
    }
    const handleAgentSnapshot = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; initial?: boolean; agents: AgentPaneState[] }>).detail
      if (!detail?.hostId || !Array.isArray(detail.agents)) return
      updateSnapshotCache(detail.hostId, detail.agents)
    }
    const handleAgentRemoved = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; sessionName: string; paneId: string }>).detail
      if (!detail?.hostId || !detail.sessionName || !detail.paneId) return
      removedAgentKeysRef.current.add(`${detail.hostId}:${detail.paneId}`)
      removeAgentCache(detail.hostId, detail.sessionName, detail.paneId)
    }
    const handleAgentNotification = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; sessionName: string; pane: AgentPaneState; eventId?: string; initial?: boolean }>).detail
      if (!detail?.hostId || !detail.sessionName || !detail.pane || detail.initial) return
      if (!removedAgentKeysRef.current.has(`${detail.hostId}:${detail.pane.paneId}`)) updateAgentCache(detail.hostId, detail.sessionName, detail.pane)
      publishNotification(detail.hostId, detail.sessionName, detail.pane, detail.eventId)
    }
    window.addEventListener('tmuxgo-agent-status', handleAgentStatus as EventListener)
    window.addEventListener('tmuxgo-agent-status-snapshot', handleAgentSnapshot as EventListener)
    window.addEventListener('tmuxgo-agent-status-removed', handleAgentRemoved as EventListener)
    window.addEventListener('tmuxgo-agent-notification', handleAgentNotification as EventListener)
    return () => {
      window.removeEventListener('tmuxgo-agent-status', handleAgentStatus as EventListener)
      window.removeEventListener('tmuxgo-agent-status-snapshot', handleAgentSnapshot as EventListener)
      window.removeEventListener('tmuxgo-agent-status-removed', handleAgentRemoved as EventListener)
      window.removeEventListener('tmuxgo-agent-notification', handleAgentNotification as EventListener)
    }
  }, [preferences.agentNotificationsEnabled, queryClient, t])
  const displayed = centerOpen ? notifications : notifications.filter((notification) => visibleIds.includes(notification.id))
  if (!preferences.agentNotificationsEnabled) return null
  return <>
    {notifications.length > 0 && notificationBubblePosition && <button type="button" onPointerDown={handleNotificationBubblePointerDown} onPointerMove={handleNotificationBubblePointerMove} onPointerUp={handleNotificationBubblePointerUp} onPointerCancel={handleNotificationBubblePointerUp} onClick={handleNotificationBubbleClick} onContextMenu={(event) => event.preventDefault()} aria-label={t('notification.title')} title={t('notification.title')} className="tmuxgo-glass pointer-events-auto fixed z-50 flex h-9 w-9 touch-none select-none items-center justify-center rounded-full border border-[var(--line)] bg-bg-1 text-text-2 shadow-lg lg:hidden" style={{ left: notificationBubblePosition.x, top: notificationBubblePosition.y }}><FiBell aria-hidden="true" /></button>}
    {notifications.length > 0 && (centerOpen || displayed.length > 0) && <div className="pointer-events-auto fixed bottom-28 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] lg:bottom-16"><div className="overflow-hidden rounded-apple border border-[var(--line)] bg-bg-1 shadow-lg"><div className="flex items-center justify-between border-b border-[var(--line)] p-2"><button onClick={() => setCenterOpen((current) => !current)} className="text-xs text-text-2">{t('notification.title')} {notifications.length ? `(${notifications.length})` : ''}</button>{notifications.length > 0 && <button onClick={clearAll} className="text-xs text-text-3 hover:text-text-1">{t('notification.clearAll')}</button>}</div><div className="tmuxgo-scrollbar max-h-72 overflow-x-hidden overflow-y-auto">{!displayed.length && <div className="p-4 text-center text-sm text-text-3">{t('notification.empty')}</div>}{displayed.slice(0, centerOpen ? 100 : 5).map((notification) => { const attention = isAgentAttentionStatus(notification.status); return <div key={notification.id} className="flex border-b border-[var(--line)] hover:bg-bg-2"><button onClick={() => void openNotification(notification)} className="min-w-0 flex-1 p-2 text-left"><span className={`flex items-center gap-1.5 text-xs ${attention ? 'text-danger' : 'text-accent-2'}`}>{attention ? <FiAlertCircle aria-hidden="true" /> : <FiCheckCircle aria-hidden="true" />}{notification.paneName}</span><span className="mt-1 block text-sm text-text-1">{notification.message}</span><span className="mt-1 block text-caption text-text-3">{new Date(notification.timestamp).toLocaleString()}</span></button><button onClick={() => dismissNotification(notification.id)} className="flex w-9 shrink-0 items-start justify-center pt-2 text-text-3 hover:text-text-1" aria-label={t('common.close')}><FiX aria-hidden="true" /></button></div> })}</div></div></div>}
  </>
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
    if (!isWatched && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
  }
  const unavailable = !paneId
  const label = unavailable ? t('notification.watch') : isWatched ? t('notification.unwatch') : t('notification.watch')
  return <Chip onClick={toggle} disabled={unavailable} aria-pressed={isWatched} aria-label={label} title={label} tone={isWatched ? 'accent' : 'default'} className={`flex items-center ${compact ? 'px-[10px]' : 'w-full justify-center gap-2 px-[10px] py-[5px]'} ${unavailable ? 'cursor-not-allowed' : ''}`}>{isWatched ? <FiBell aria-hidden="true" /> : <FiBellOff aria-hidden="true" />}{!compact && <span>{label}</span>}</Chip>
}
