'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import { usePreferences } from '@/hooks/usePreferences'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { buildSessionId } from '@/lib/session-id'
import { mergeAgentPaneEvent, summarizeAgentStates } from '@/lib/agent-status'
import { api } from '@/lib/api'
import type { AgentPaneState, Session } from '@/types'
import { FiAlertCircle, FiBell, FiBellOff, FiCheckCircle, FiX } from 'react-icons/fi'

interface NotificationItem {
  id: string
  paneId: string
  paneName: string
  hostId: string
  sessionId: string
  status: 'blocked' | 'done'
  message: string
  timestamp: string
}
const notificationsStorageKey = 'tmuxgo-pane-notifications'
const watchedPanesStorageKey = 'tmuxgo-watched-panes'
function readStoredNotifications() {
  try {
    const raw = JSON.parse(localStorage.getItem(notificationsStorageKey) || '[]')
    return Array.isArray(raw) ? raw.filter((item): item is NotificationItem => item && typeof item.id === 'string' && typeof item.paneId === 'string' && typeof item.timestamp === 'string').slice(0, 100) : []
  } catch {
    return []
  }
}
function readWatchedPanes() {
  try {
    const raw = JSON.parse(localStorage.getItem(watchedPanesStorageKey) || '[]')
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
export function PaneNotifications() {
  const [notifications, setNotifications] = useState<NotificationItem[]>(readStoredNotifications)
  const [visibleIds, setVisibleIds] = useState<string[]>([])
  const [centerOpen, setCenterOpen] = useState(false)
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const queryClient = useOptionalQueryClient()
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const setActivePane = useConsoleStore((state) => state.setActivePane)
  const updateNotifications = (update: (current: NotificationItem[]) => NotificationItem[]) => {
    setNotifications((current) => {
      const next = update(current).slice(0, 100)
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
    const handleAgentStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; sessionName: string; pane: AgentPaneState; initial?: boolean }>).detail
      if (!detail?.hostId || !detail.sessionName || !detail.pane) return
      const sessionId = buildSessionId(detail.hostId, detail.sessionName)
      queryClient?.setQueryData(['session-snapshot', detail.hostId, sessionId], (snapshot: any) => snapshot ? { ...snapshot, panes: mergeAgentPaneEvent(Array.isArray(snapshot.panes) ? snapshot.panes : [], detail.pane) } : snapshot)
      queryClient?.setQueryData<Session[]>(['sessions', detail.hostId], (sessions) => sessions?.map((session) => {
        if (session.id !== sessionId) return session
        const agents = [...(session.agents || []).filter((pane) => pane.paneId !== detail.pane.paneId), detail.pane]
        return { ...session, agents, agentSummary: summarizeAgentStates(agents) }
      }))
      const status = detail.pane.agentStatus
      if (detail.initial || status !== 'blocked' && status !== 'done' || !preferences.agentNotificationsEnabled) return
      if (!readWatchedPanes().includes(detail.pane.paneId)) return
      const state = useConsoleStore.getState()
      if (state.activeHostId === detail.hostId && state.activeSessionId === sessionId && state.activePaneId === detail.pane.paneId) return
      const id = `${detail.pane.paneId}:${detail.pane.revision}`
      const message = status === 'blocked' ? t('agent.notification.blocked', { agent: detail.pane.agent, session: detail.sessionName }) : t('agent.notification.done', { agent: detail.pane.agent, session: detail.sessionName })
      const notification: NotificationItem = { id, paneId: detail.pane.paneId, paneName: detail.pane.agent, hostId: detail.hostId, sessionId, status, message, timestamp: new Date().toISOString() }
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
    window.addEventListener('tmuxgo-agent-status', handleAgentStatus as EventListener)
    return () => window.removeEventListener('tmuxgo-agent-status', handleAgentStatus as EventListener)
  }, [preferences.agentNotificationsEnabled, queryClient, t])
  const displayed = centerOpen ? notifications : notifications.filter((notification) => visibleIds.includes(notification.id))
  if (!preferences.agentNotificationsEnabled) return null
  return <div className="fixed bottom-28 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] lg:bottom-16"><button onClick={() => setCenterOpen((current) => !current)} aria-label={t('notification.title')} title={t('notification.title')} className={`mb-2 ml-auto flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line)] bg-bg-1 text-text-2 shadow-lg lg:hidden ${notifications.length ? '' : 'hidden'}`}><FiBell aria-hidden="true" /></button>{(centerOpen || displayed.length > 0) && <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-bg-1 shadow-lg"><div className="flex items-center justify-between border-b border-[var(--line)] p-2"><button onClick={() => setCenterOpen((current) => !current)} className="text-xs text-text-2">{t('notification.title')} {notifications.length ? `(${notifications.length})` : ''}</button>{notifications.length > 0 && <button onClick={clearAll} className="text-xs text-text-3 hover:text-text-1">{t('notification.clearAll')}</button>}</div><div className="max-h-72 overflow-y-auto">{!displayed.length && <div className="p-4 text-center text-sm text-text-3">{t('notification.empty')}</div>}{displayed.slice(0, centerOpen ? 100 : 5).map((notification) => <div key={notification.id} className="flex border-b border-[var(--line)] hover:bg-bg-2"><button onClick={() => void openNotification(notification)} className="min-w-0 flex-1 p-2 text-left"><span className={`flex items-center gap-1.5 text-xs ${notification.status === 'blocked' ? 'text-danger' : 'text-emerald-300'}`}>{notification.status === 'blocked' ? <FiAlertCircle aria-hidden="true" /> : <FiCheckCircle aria-hidden="true" />}{notification.paneName}</span><span className="mt-1 block text-sm text-text-1">{notification.message}</span><span className="mt-1 block text-[10px] text-text-3">{new Date(notification.timestamp).toLocaleString()}</span></button><button onClick={() => dismissNotification(notification.id)} className="flex w-9 shrink-0 items-start justify-center pt-2 text-text-3 hover:text-text-1" aria-label={t('common.close')}><FiX aria-hidden="true" /></button></div>)}</div></div>}</div>
}
export function WatchButton({ paneId, compact = false }: { paneId: string; compact?: boolean }) {
  const [isWatched, setIsWatched] = useState(false)
  const { t } = useTranslation()
  useEffect(() => {
    setIsWatched(!!paneId && readWatchedPanes().includes(paneId))
  }, [paneId])
  if (!paneId) return null
  const toggle = () => {
    const watched = readWatchedPanes()
    const updated = isWatched ? watched.filter((id) => id !== paneId) : [...watched.filter((id) => id !== paneId), paneId]
    localStorage.setItem(watchedPanesStorageKey, JSON.stringify(updated))
    setIsWatched(!isWatched)
    window.dispatchEvent(new CustomEvent('tmuxgo-watched-panes-change', { detail: { paneId, watched: !isWatched } }))
    if (!isWatched && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
  }
  return <button onClick={toggle} aria-pressed={isWatched} aria-label={isWatched ? t('notification.unwatch') : t('notification.watch')} title={isWatched ? t('notification.unwatch') : t('notification.watch')} className={compact ? `flex h-8 items-center gap-1 rounded-md px-2 text-[11px] ${isWatched ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-3'}` : `flex w-full items-center justify-center gap-2 rounded px-2 py-1.5 text-xs ${isWatched ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2'}`}>{isWatched ? <FiBell aria-hidden="true" /> : <FiBellOff aria-hidden="true" />}{!compact && <span>{isWatched ? t('notification.unwatch') : t('notification.watch')}</span>}</button>
}
