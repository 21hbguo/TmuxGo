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
import { FiAlertCircle, FiCheckCircle, FiX } from 'react-icons/fi'

interface Notification {
  id: string
  paneId: string
  paneName: string
  hostId: string
  sessionId: string
  status: 'blocked' | 'done'
  message: string
  timestamp: Date
}

export function PaneNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const queryClient = useOptionalQueryClient()
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const setActivePane = useConsoleStore((state) => state.setActivePane)

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }

  const clearAll = () => {
    setNotifications([])
  }
  useEffect(() => {
    if (!preferences.agentNotificationsEnabled) setNotifications([])
  }, [preferences.agentNotificationsEnabled])
  useEffect(() => {
    if (!preferences.agentNotificationsEnabled || !notifications.length) return
    const now = Date.now()
    const timers = notifications.map((notification) => window.setTimeout(() => dismissNotification(notification.id), Math.max(0, preferences.agentNotificationDurationMs - (now - notification.timestamp.getTime()))))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [notifications, preferences.agentNotificationDurationMs, preferences.agentNotificationsEnabled])
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
      if (detail.initial || status !== 'blocked' && status !== 'done') return
      if (!preferences.agentNotificationsEnabled) return
      const state = useConsoleStore.getState()
      if (state.activeHostId === detail.hostId && state.activeSessionId === sessionId && state.activePaneId === detail.pane.paneId) return
      const id = `${detail.pane.paneId}:${detail.pane.revision}`
      const message = status === 'blocked' ? t('agent.notification.blocked', { agent: detail.pane.agent, session: detail.sessionName }) : t('agent.notification.done', { agent: detail.pane.agent, session: detail.sessionName })
      setNotifications((current) => [{ id, paneId: detail.pane.paneId, paneName: detail.pane.agent, hostId: detail.hostId, sessionId, status, message, timestamp: new Date() }, ...current.filter((item) => item.id !== id)].slice(0, 8))
    }
    window.addEventListener('tmuxgo-agent-status', handleAgentStatus as EventListener)
    return () => window.removeEventListener('tmuxgo-agent-status', handleAgentStatus as EventListener)
  }, [preferences.agentNotificationsEnabled, queryClient, t])
  const openNotification = async (notification: Notification) => {
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
    } catch {}
  }

  return (
    <div className="fixed bottom-28 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] lg:bottom-16">
      {notifications.length > 0 && (
        <div className="bg-bg-1 border border-[var(--line)] rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-[var(--line)] flex items-center justify-between">
            <span className="text-text-2 text-xs">{t('notification.title')}</span>
            <button onClick={clearAll} className="text-text-3 text-xs hover:text-text-1">
              {t('notification.clearAll')}
            </button>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {notifications.slice(0, 5).map((n) => (
              <div key={n.id} className="flex border-b border-[var(--line)] hover:bg-bg-2">
                <button onClick={() => void openNotification(n)} className="min-w-0 flex-1 p-2 text-left"><span className={`flex items-center gap-1.5 text-xs ${n.status === 'blocked' ? 'text-danger' : 'text-emerald-300'}`}>{n.status === 'blocked' ? <FiAlertCircle aria-hidden="true" /> : <FiCheckCircle aria-hidden="true" />}{n.paneName}</span><span className="mt-1 block text-sm text-text-1">{n.message}</span></button>
                <button onClick={() => dismissNotification(n.id)} className="flex w-9 shrink-0 items-start justify-center pt-2 text-text-3 hover:text-text-1" aria-label={t('common.close')}><FiX aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function WatchButton({ paneId }: { paneId: string }) {
  const [isWatched, setIsWatched] = useState(false)
  const { t } = useTranslation()
  const readWatchedPanes = () => {
    try {
      const raw = JSON.parse(localStorage.getItem('tmuxgo-watched-panes') || '[]')
      return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  useEffect(() => {
    setIsWatched(readWatchedPanes().includes(paneId))
  }, [paneId])

  const toggle = () => {
    const watched = readWatchedPanes()
    const updated = isWatched ? watched.filter((id) => id !== paneId) : [...watched, paneId]
    localStorage.setItem('tmuxgo-watched-panes', JSON.stringify(updated))
    setIsWatched(!isWatched)
  }

  return (
    <button
      onClick={toggle}
      className={`p-1 rounded text-xs ${isWatched ? 'text-accent' : 'text-text-3'}`}
      title={isWatched ? t('notification.unwatch') : t('notification.watch')}
    >
      {isWatched ? '🔔' : '🔕'}
    </button>
  )
}
