'use client'
import { useEffect, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession, useDeleteSession, useSessions } from '@/hooks/useApi'
import { SessionTemplates, type Template } from './SessionTemplates'
import { ConfirmDialog } from './ConfirmDialog'
import { QuickActions } from './QuickActions'
import { usePreferences } from '@/hooks/usePreferences'

export function SessionPanel() {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const { preferences } = usePreferences()
  const [showTemplates, setShowTemplates] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const handleTemplateSelect = async (template: Template) => {
    if (!activeHostId) return
    const name = prompt('Session name:', template.name.toLowerCase())
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
  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])
  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-bg-1">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
          <div className="text-sm font-semibold text-text-1">Sessions</div>
          <button onClick={() => setShowTemplates(true)} className="rounded bg-bg-2 px-2 py-1 text-[11px] text-accent hover:text-text-1">New</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.map((session) => (
            <div key={session.id} className="group relative border-b border-[rgba(255,255,255,0.03)]">
              <button onClick={() => setActiveSession(session.id)} className={`w-full border-l-2 px-3 py-2 text-left ${activeSessionId === session.id ? 'border-accent bg-bg-2/80' : 'border-transparent hover:bg-bg-2/60'}`}>
                <div className="truncate text-sm text-text-1">{session.name}</div>
                <div className="mt-0.5 text-[11px] text-text-3">{session.windowCount} windows</div>
              </button>
              <button onClick={() => setPendingDeleteSessionId(session.id)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-1 text-[11px] text-text-3 opacity-0 hover:bg-bg-0 hover:text-danger group-hover:opacity-100">×</button>
            </div>
          ))}
        </div>
        {preferences.showQuickActions && <div className="border-t border-[var(--line)] p-3"><div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-3">Quick Actions</div><QuickActions /></div>}
      </div>
      {showTemplates && <SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} />}
      <ConfirmDialog open={!!pendingDeleteSessionId} title="Delete session" message={`Delete ${sessions.find((item) => item.id === pendingDeleteSessionId)?.name || ''}?`} confirmLabel="Delete" cancelLabel="Cancel" tone="danger" onCancel={() => setPendingDeleteSessionId(null)} onConfirm={() => void confirmDeleteSession()} />
    </>
  )
}
