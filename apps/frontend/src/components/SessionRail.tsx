'use client'
import { useEffect, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession } from '@/hooks/useApi'
import { SessionTemplates, type Template } from './SessionTemplates'

export function SessionRail() {
  const { sessions, activeSessionId, setActiveSession, activeHostId, pushToast, setSessionPanelExpanded } = useConsoleStore()
  const createSession = useCreateSession()
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
      <aside className="flex h-full w-16 shrink-0 flex-col border-r border-[var(--line)] bg-bg-1">
        <button onClick={() => setSessionPanelExpanded(true)} className="flex h-11 items-center justify-center border-b border-[var(--line)] text-xs font-semibold text-text-3 hover:bg-bg-2 hover:text-text-1">▸</button>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <div className="flex flex-col gap-2">
            {sessions.map((session) => {
              const active = session.id === activeSessionId
              return (
                <button key={session.id} title={session.name} onClick={() => setActiveSession(session.id)} className={`flex h-11 items-center justify-center rounded-lg border text-xs font-semibold ${active ? 'border-[var(--line)] bg-bg-2 text-accent' : 'border-transparent bg-transparent text-text-3 hover:bg-bg-2 hover:text-text-1'}`}>
                  {session.name.slice(0, 2).toUpperCase()}
                </button>
              )
            })}
          </div>
        </div>
        <div className="border-t border-[var(--line)] p-2">
          <button onClick={() => setShowTemplates(true)} className="flex h-10 w-full items-center justify-center rounded-lg bg-bg-2 text-sm text-accent hover:text-text-1">+</button>
        </div>
      </aside>
      {showTemplates && <SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} />}
    </>
  )
}
