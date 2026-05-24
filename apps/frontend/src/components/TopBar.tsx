'use client'

import { useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { ConnectionBadge } from './ConnectionBadge'
import { Settings } from './Settings'
import { useTranslation } from '@/i18n'

export function TopBar() {
  const { activeHostId, activeSessionId, hosts, sessions, setCommandPalette } = useConsoleStore()
  const [showSettings, setShowSettings] = useState(false)
  const { t } = useTranslation()

  const activeHost = hosts.find((h: any) => h.id === activeHostId)
  const activeSession = sessions.find((s: any) => s.id === activeSessionId)

  return (
    <>
      <header className="h-14 bg-bg-1 border-b border-[var(--line)] flex items-center px-4 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-accent font-bold text-lg">tmuxU</span>
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
          <ConnectionBadge />
          <button
            onClick={() => setShowSettings(true)}
            className="w-8 h-8 rounded-full bg-bg-2 flex items-center justify-center text-text-3 hover:text-text-1"
          >
            ⚙
          </button>
          <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-accent text-sm font-medium">
            U
          </div>
        </div>
      </header>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </>
  )
}
