'use client'

import { useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession, useDeleteSession, useRenameSession, useSessions } from '@/hooks/useApi'
import { SessionTemplates, type Template } from './SessionTemplates'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { QuickActions } from './QuickActions'
import { ConfirmDialog } from './ConfirmDialog'

export function Sidebar() {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const sessionPanelWidth = useConsoleStore((state) => state.sessionPanelWidth)
  const setSessionPanelWidth = useConsoleStore((state) => state.setSessionPanelWidth)
  const setSessionPanelExpanded = useConsoleStore((state) => state.setSessionPanelExpanded)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const renameSession = useRenameSession()
  const [showTemplates, setShowTemplates] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const resizingRef = useRef(false)

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return
      setSessionPanelWidth(preferences.sidebarPosition === 'right' ? window.innerWidth - event.clientX : event.clientX)
    }
    const handleUp = () => {
      resizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [preferences.sidebarPosition, setSessionPanelWidth])

  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])

  const handleCreateSession = async () => {
    setShowTemplates(true)
  }

  const handleTemplateSelect = async (template: Template) => {
    if (!activeHostId) return
    const name = prompt('Session name:', template.name.toLowerCase())
    if (name) {
      try {
        const created = await createSession.mutateAsync({ hostId: activeHostId, name, layout: template.layout })
        if (created?.id) {
          setActiveSession(created.id)
          pushToast({ type: 'success', message: `Session ${name} created` })
        }
      } catch (err) {
        pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
      }
    }
    setShowTemplates(false)
  }

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setPendingDeleteSessionId(sessionId)
  }
  const handleRenameSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!activeHostId) return
    const session = sessions.find((item: any) => item.id === sessionId)
    const name = window.prompt(t('drawer.renamePrompt'), session?.name || '')
    if (!name || name === session?.name) return
    try {
      const renamed = await renameSession.mutateAsync({ hostId: activeHostId, sessionId, name })
      if (activeSessionId === sessionId && renamed?.id) setActiveSession(renamed.id)
      pushToast({ type: 'success', message: `Session ${session?.name || sessionId} renamed to ${name}` })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
    }
  }

  const confirmDeleteSession = async () => {
    if (!activeHostId || !pendingDeleteSessionId) return
    const session = sessions.find((s: any) => s.id === pendingDeleteSessionId)
    const name = session?.name || pendingDeleteSessionId
    try {
      await deleteSession.mutateAsync({ hostId: activeHostId, sessionId: pendingDeleteSessionId })
      if (activeSessionId === pendingDeleteSessionId) {
        const remaining = sessions.filter((s: any) => s.id !== pendingDeleteSessionId)
        setActiveSession(remaining[0]?.id || '')
      }
      pushToast({ type: 'success', message: `Session ${name} deleted` })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
    }
    setPendingDeleteSessionId(null)
  }

  return (
    <>
      <aside className={`relative flex shrink-0 flex-col bg-bg-1 ${preferences.sidebarPosition === 'right' ? 'border-l border-[var(--line)]' : 'border-r border-[var(--line)]'}`} style={{ width: sessionPanelWidth }}>
        <div className="flex items-center justify-between border-b border-[var(--line)] p-3">
          <span className="text-text-2 text-sm font-medium">{t('sidebar.sessions')}</span>
          <button onClick={() => setSessionPanelExpanded(false)} className="rounded p-1.5 text-text-3 hover:bg-bg-2">
            ←
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.map((session: any) => (
            <div key={session.id} className="relative flex items-center gap-1 pr-2">
              <button
                onClick={() => setActiveSession(session.id)}
                className={`w-full px-3 py-2 text-left hover:bg-bg-2 transition-colors ${
                  activeSessionId === session.id ? 'bg-bg-2 border-l-2 border-accent' : 'border-l-2 border-transparent'
                }`}
              >
                <div className="text-text-1 text-sm">{session.name}</div>
                <div className="text-text-3 text-xs mt-0.5">
                  {t('sidebar.windows', { count: session.windowCount })}
                </div>
              </button>
              <button
                onClick={(e) => void handleRenameSession(session.id, e)}
                className="rounded p-1 text-text-3 hover:bg-bg-0 hover:text-text-1"
                title={t('sidebar.renameSession')}
                aria-label={t('sidebar.renameSession')}
              >
                ✎
              </button>
              <button
                onClick={(e) => handleDeleteSession(session.id, e)}
                className="rounded p-1 text-text-3 hover:text-red-400 hover:bg-red-900/30"
                title={t('sidebar.deleteSession')}
                aria-label={t('sidebar.deleteSession')}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={handleCreateSession}
            className="w-full px-3 py-2 text-left text-accent text-sm transition-colors hover:bg-bg-2"
          >
            {t('sidebar.newSession')}
          </button>
        </div>
        {preferences.showQuickActions && (
          <div className="p-3 border-t border-[var(--line)]">
            <div className="text-text-3 text-xs mb-2">{t('sidebar.quickActions')}</div>
            <QuickActions />
          </div>
        )}
        <div
          className={`absolute top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 ${preferences.sidebarPosition === 'right' ? 'left-0' : 'right-0'}`}
          onMouseDown={() => {
            resizingRef.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        />
      </aside>

      {showTemplates && (
        <SessionTemplates
          onSelect={handleTemplateSelect}
          onClose={() => setShowTemplates(false)}
        />
      )}
      <ConfirmDialog
        open={!!pendingDeleteSessionId}
        title={t('sidebar.deleteTitle')}
        message={t('sidebar.deleteConfirm', { name: sessions.find((s: any) => s.id === pendingDeleteSessionId)?.name || '' })}
        confirmLabel={t('sidebar.confirmDelete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingDeleteSessionId(null)}
        onConfirm={() => void confirmDeleteSession()}
      />
    </>
  )
}
