'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { ConnectionBadge } from './ConnectionBadge'
import { useTranslation } from '@/i18n'
import { useHosts, useSessions } from '@/hooks/useApi'

export function TopBar() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setCommandPalette = useConsoleStore((state) => state.setCommandPalette)
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const toggleSessionPanel = useConsoleStore((state) => state.toggleSessionPanel)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const toggleFilePanel = useConsoleStore((state) => state.toggleFilePanel)
  const { data: hosts = [] } = useHosts()
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const { t } = useTranslation()

  const activeHost = hosts.find((h: any) => h.id === activeHostId)
  const activeSession = sessions.find((s: any) => s.id === activeSessionId)

  return (
    <>
      <header className="h-14 bg-bg-1 border-b border-[var(--line)] flex items-center px-4 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-accent font-bold text-lg">TmuxGo</span>
          {activeHost && (
            <>
              <span className="text-text-3">/</span>
              <span className="text-text-2">{activeHost.name}</span>
            </>
          )}
          {activeSession && (
            <>
              <span className="text-text-3">:</span>
              <span className="text-text-1">{activeSession.name}</span>
            </>
          )}
        </div>

        <div className="flex-1 flex justify-center">
          <button
            onClick={() => setCommandPalette(true)}
            className="px-4 py-1.5 bg-bg-2 rounded-lg text-text-3 text-sm hover:bg-bg-1 transition-colors flex items-center gap-2"
          >
            <span>⌕</span>
            <span>{t('search.placeholder')}</span>
            <kbd className="px-1.5 py-0.5 bg-bg-1 rounded text-text-3 text-xs">{t('search.cmd')}</kbd>
          </button>
        </div>

        <div className="flex items-center gap-4">
          <button onClick={toggleSessionPanel} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${sessionPanelExpanded ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-3 hover:text-text-1'}`}>
            Sessions
          </button>
          <button onClick={toggleFilePanel} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${filePanelOpen ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-3 hover:text-text-1'}`}>
            Files
          </button>
          <ConnectionBadge />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings'))}
            className="w-8 h-8 rounded-full bg-bg-2 flex items-center justify-center text-text-3 hover:text-text-1"
          >
            ⚙
          </button>
          <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-accent text-sm font-medium">
            U
          </div>
        </div>
      </header>
    </>
  )
}
