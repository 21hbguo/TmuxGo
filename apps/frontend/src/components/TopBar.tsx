'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { ConnectionBadge } from './ConnectionBadge'
import { useTranslation } from '@/i18n'
import { useHosts, useSessions } from '@/hooks/useApi'
import { FiSettings } from 'react-icons/fi'

export function TopBar() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const { data: hosts = [] } = useHosts()
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const { t } = useTranslation()

  const activeHost = hosts.find((h: any) => h.id === activeHostId)
  const activeSession = sessions.find((s: any) => s.id === activeSessionId)

  return (
      <header className="tmuxgo-glass tmuxgo-glass-chrome relative z-30 flex h-14 shrink-0 items-center border-b px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/app-icon.svg" alt="" className="h-8 w-8" />
          <span className="text-base font-semibold text-text-1">TmuxGo</span>
          {activeHost && (
            <>
              <span className="text-xs text-text-3">/</span>
              <span className="max-w-36 truncate text-sm text-text-2">{activeHost.name}</span>
            </>
          )}
          {activeSession && (
            <>
              <span className="text-xs text-text-3">/</span>
              <span className="max-w-44 truncate text-sm text-text-1">{activeSession.name}</span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ConnectionBadge />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings'))}
            aria-label={t('activity.settings')}
            title={t('activity.settings')}
            className="tmuxgo-toolbar-icon tmuxgo-glass-control h-9 w-9 rounded-full"
          >
            <FiSettings aria-hidden="true" size={17} />
          </button>
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/35 bg-accent/10 text-sm font-semibold text-accent">
            U
          </div>
        </div>
      </header>
  )
}
