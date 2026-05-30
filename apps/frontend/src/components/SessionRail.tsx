'use client'
import { useEffect, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession, useSessions } from '@/hooks/useApi'
import { SessionTemplates, type Template } from './SessionTemplates'
import { useTranslation } from '@/i18n'

export function SessionRail() {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const setSessionPanelExpanded = useConsoleStore((state) => state.setSessionPanelExpanded)
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const createSession = useCreateSession()
  const { t } = useTranslation()
  const [showTemplates, setShowTemplates] = useState(false)
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
  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])
  return (
    <>
      <aside className="flex h-full w-[clamp(88px,13vw,176px)] shrink-0 flex-col border-r border-[var(--line)] bg-bg-1">
        <button onClick={() => setSessionPanelExpanded(true)} className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 text-left text-xs font-semibold text-text-3 hover:bg-bg-2 hover:text-text-1"><span>▸</span><span className="min-w-0 truncate">{t('sidebar.sessions')}</span></button>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 scrollbar-none">
          <div className="flex min-h-full flex-col gap-2">
            {sessions.map((session) => {
              const active = session.id === activeSessionId
              return (
                <button key={session.id} title={session.name} onClick={() => setActiveSession(session.id)} className={`flex h-11 min-w-0 items-center gap-2 rounded-lg border px-2 text-left transition-colors ${active ? 'border-[var(--line)] bg-bg-2 text-accent' : 'border-transparent bg-transparent text-text-3 hover:bg-bg-2 hover:text-text-1'}`}>
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ${active ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2'}`}>{session.name.slice(0, 2).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-text-1">{session.name}</span>
                    <span className="block truncate text-[10px] text-text-3">{t('sidebar.windows', { count: session.windowCount })}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="shrink-0 border-t border-[var(--line)] p-2">
          <button onClick={() => setShowTemplates(true)} className="flex h-10 w-full items-center justify-center rounded-lg bg-bg-2 text-sm text-accent hover:text-text-1">+</button>
        </div>
      </aside>
      {showTemplates && <SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} />}
    </>
  )
}
