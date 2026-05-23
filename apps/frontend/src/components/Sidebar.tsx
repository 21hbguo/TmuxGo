'use client'

import { useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession } from '@/hooks/useApi'
import { SessionTemplates, type Template } from './SessionTemplates'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { QuickActions } from './QuickActions'

export function Sidebar() {
  const { sessions, activeSessionId, setActiveSession, activeHostId, sidebarCollapsed, toggleSidebar } = useConsoleStore()
  const createSession = useCreateSession()
  const [showTemplates, setShowTemplates] = useState(false)
  const { preferences } = usePreferences()
  const { t } = useTranslation()

  const handleCreateSession = async () => {
    setShowTemplates(true)
  }

  const handleTemplateSelect = async (template: Template) => {
    if (!activeHostId) return
    const name = prompt('Session name:', template.name.toLowerCase())
    if (name) {
      const created = await createSession.mutateAsync({ hostId: activeHostId, name })
      if (created?.id) {
        setActiveSession(created.id)
      }
    }
    setShowTemplates(false)
  }

  return (
    <>
      <aside
        className={`bg-bg-1 border-r border-[var(--line)] shrink-0 transition-all duration-200 flex flex-col ${
          sidebarCollapsed ? 'w-[72px]' : 'w-[280px]'
        }`}
      >
        <div className="p-3 flex items-center justify-between border-b border-[var(--line)]">
          {!sidebarCollapsed && <span className="text-text-2 text-sm font-medium">{t('sidebar.sessions')}</span>}
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded hover:bg-bg-2 text-text-3"
          >
            {sidebarCollapsed ? '→' : '←'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.map((session: any) => (
            <button
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              className={`w-full px-3 py-2 text-left hover:bg-bg-2 transition-colors ${
                activeSessionId === session.id ? 'bg-bg-2 border-l-2 border-accent' : 'border-l-2 border-transparent'
              }`}
            >
              {sidebarCollapsed ? (
                <div className="w-8 h-8 rounded bg-accent/20 flex items-center justify-center text-accent text-xs mx-auto">
                  {session.name[0].toUpperCase()}
                </div>
              ) : (
                <>
                  <div className="text-text-1 text-sm">{session.name}</div>
                  <div className="text-text-3 text-xs mt-0.5">
                    {t('sidebar.windows', { count: session.windowCount })}
                  </div>
                </>
              )}
            </button>
          ))}

          <button
            onClick={handleCreateSession}
            className={`w-full px-3 py-2 text-left hover:bg-bg-2 transition-colors text-accent text-sm ${
              sidebarCollapsed ? 'text-center' : ''
            }`}
          >
            {sidebarCollapsed ? '+' : t('sidebar.newSession')}
          </button>
        </div>

        {!sidebarCollapsed && preferences.showQuickActions && (
          <div className="p-3 border-t border-[var(--line)]">
            <div className="text-text-3 text-xs mb-2">{t('sidebar.quickActions')}</div>
            <QuickActions />
          </div>
        )}
      </aside>

      {showTemplates && (
        <SessionTemplates
          onSelect={handleTemplateSelect}
          onClose={() => setShowTemplates(false)}
        />
      )}
    </>
  )
}
