'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { ConnectionBadge } from './ConnectionBadge'
import { useTranslation } from '@/i18n'
import { useHosts, useSessions } from '@/hooks/useApi'
import { FiSearch, FiSettings } from 'react-icons/fi'

export function TopBar() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setCommandPalette = useConsoleStore((state) => state.setCommandPalette)
  const { data: hosts = [] } = useHosts()
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const { t } = useTranslation()

  const activeHost = hosts.find((h: any) => h.id === activeHostId)
  const activeSession = sessions.find((s: any) => s.id === activeSessionId)

  return (
      <header className="tmuxgo-glass tmuxgo-glass-chrome relative z-30 flex h-14 shrink-0 items-center border-b px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/app-icon.svg" alt="" className="h-8 w-8 shadow-sm" />
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

        <div className="flex flex-1 justify-center px-4">
          <button
            onClick={() => setCommandPalette(true)}
            aria-label={t('search.placeholder')}
            className="tmuxgo-glass-control flex h-9 w-full max-w-[360px] items-center gap-2 px-3 text-sm text-text-3 transition-colors"
          >
            <FiSearch aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{t('search.placeholder')}</span>
            <kbd className="tmuxgo-keycap tmuxgo-keycap--sm">{t('search.cmd')}</kbd>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ConnectionBadge />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings'))}
            aria-label={t('activity.settings')}
            title={t('activity.settings')}
            className="tmuxgo-icon-button tmuxgo-glass-control flex h-9 w-9 items-center justify-center rounded-full text-text-3 hover:text-text-1"
          >
            <FiSettings aria-hidden="true" size={17} />
          </button>
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/25 bg-accent/15 text-sm font-semibold text-accent">
            U
          </div>
        </div>
      </header>
  )
}
