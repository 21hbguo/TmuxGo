'use client'
import { useEffect, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession, useDeleteSession, useRenameSession, useSessions } from '@/hooks/useApi'
import { SessionTemplates, type Template } from './SessionTemplates'
import { ConfirmDialog } from './ConfirmDialog'
import { QuickActions } from './QuickActions'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'

export function SessionPanel() {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const renameSession = useRenameSession()
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const [showTemplates, setShowTemplates] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const handleTemplateSelect = async (template: Template) => {
    if (!activeHostId) return
    const name = prompt(t('drawer.sessionName'), template.name.toLowerCase())
    if (!name) {
      setShowTemplates(false)
      return
    }
    try {
      const created = await createSession.mutateAsync({ hostId: activeHostId, name, layout: template.layout })
      if (created?.id) {
        setActiveSession(created.id)
        pushToast({ type: 'success', message: `Session ${name} created` })
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
    }
    setShowTemplates(false)
  }
  const confirmDeleteSession = async () => {
    if (!activeHostId || !pendingDeleteSessionId) return
    const session = sessions.find((item) => item.id === pendingDeleteSessionId)
    try {
      await deleteSession.mutateAsync({ hostId: activeHostId, sessionId: pendingDeleteSessionId })
      if (activeSessionId === pendingDeleteSessionId) setActiveSession(sessions.find((item) => item.id !== pendingDeleteSessionId)?.id || '')
      pushToast({ type: 'success', message: `Session ${session?.name || pendingDeleteSessionId} deleted` })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
    }
    setPendingDeleteSessionId(null)
  }
  const handleRenameSession = async (sessionId: string) => {
    if (!activeHostId) return
    const session = sessions.find((item) => item.id === sessionId)
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
  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])
  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-bg-1">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
          <div className="text-sm font-semibold text-text-1">{t('sidebar.sessions')}</div>
          <button onClick={() => setShowTemplates(true)} className="rounded bg-bg-2 px-2 py-1 text-[11px] text-accent hover:text-text-1">{t('sidebar.newAction')}</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.map((session) => (
            <div key={session.id} className={`flex items-center gap-1 border-b border-[rgba(255,255,255,0.03)] pr-2 ${activeSessionId === session.id ? 'bg-bg-2/80' : ''}`}>
              <button onClick={() => setActiveSession(session.id)} onDoubleClick={() => void handleRenameSession(session.id)} className={`min-w-0 flex-1 border-l-2 px-3 py-2 text-left ${activeSessionId === session.id ? 'border-accent' : 'border-transparent hover:bg-bg-2/60'}`}>
                <div className="truncate text-sm text-text-1">{session.name}</div>
                <div className="mt-0.5 text-[11px] text-text-3">{t('sidebar.windows', { count: session.windowCount })}</div>
              </button>
              <button onClick={() => void handleRenameSession(session.id)} className="rounded px-1.5 py-1 text-[11px] text-text-3 hover:bg-bg-0 hover:text-text-1" aria-label={t('sidebar.renameSession')} title={t('sidebar.renameSession')}>✎</button>
              <button onClick={() => setPendingDeleteSessionId(session.id)} className="rounded px-1.5 py-1 text-[11px] text-text-3 hover:bg-bg-0 hover:text-danger" aria-label={t('sidebar.deleteSession')} title={t('sidebar.deleteSession')}>×</button>
            </div>
          ))}
        </div>
        {preferences.showQuickActions && <div className="border-t border-[var(--line)] p-3"><div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-3">{t('sidebar.quickActions')}</div><QuickActions /></div>}
      </div>
      {showTemplates && <SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} />}
      <ConfirmDialog open={!!pendingDeleteSessionId} title={t('sidebar.deleteTitle')} message={t('sidebar.deleteConfirm', { name: sessions.find((item) => item.id === pendingDeleteSessionId)?.name || '' })} confirmLabel={t('sidebar.confirmDelete')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDeleteSessionId(null)} onConfirm={() => void confirmDeleteSession()} />
    </>
  )
}
