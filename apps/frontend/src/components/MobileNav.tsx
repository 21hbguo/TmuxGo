'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

interface MobileNavProps {
  onOpenDrawer: (type: 'sessions' | 'panes') => void
  onOpenSettings: () => void
  onOpenSearch: () => void
  onOpenFiles: () => void
  docked?: boolean
}

function NavIcon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

const icons = {
  sessions: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  panes: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  files: 'M3 5h7l2 2h9v12H3z',
  search: 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
}

export function MobileNav({ onOpenDrawer, onOpenSettings, onOpenSearch, onOpenFiles, docked = false }: MobileNavProps) {
  const connection = useConsoleStore((state) => state.connection)
  const attachLatency = useConsoleStore((state) => state.terminalPerf.attachLatency)
  const { t } = useTranslation()

  const isConnected = connection.status === 'connected'
  const isRecovering = connection.status === 'reconnecting' || connection.status === 'attaching'
  const statusColor = isConnected ? 'bg-accent-2' : isRecovering ? 'bg-warn' : 'bg-danger'
  const statusText = isConnected ? `${connection.latency ?? 0}/${attachLatency}ms` : isRecovering ? '...' : 'Off'
  const containerClass = docked
    ? 'mobile-nav-landscape-hide h-full border-t border-[var(--line)] bg-bg-1 pb-[env(safe-area-inset-bottom)] transition-transform duration-200'
    : 'mobile-nav-landscape-hide fixed left-0 right-0 z-40 border-t border-[var(--line)] bg-bg-1 pb-[env(safe-area-inset-bottom)] transition-transform duration-200'

  return (
    <div data-mobile-nav className={containerClass} style={docked ? undefined : { bottom: 'var(--mobile-keyboard-inset, 0px)' }}>
      <div className="flex items-center justify-around h-12 px-3">
        <button onClick={() => onOpenDrawer('sessions')} className="flex flex-col items-center gap-px text-text-3 active:text-accent active:scale-95 transition-all">
          <NavIcon d={icons.sessions} />
          <span className="text-[9px] leading-none">{t('nav.sessions')}</span>
        </button>

        <button onClick={() => onOpenDrawer('panes')} className="flex flex-col items-center gap-px text-text-3 active:text-accent active:scale-95 transition-all">
          <NavIcon d={icons.panes} />
          <span className="text-[9px] leading-none">{t('nav.panes')}</span>
        </button>

        <button onClick={onOpenFiles} className="flex flex-col items-center gap-px text-text-3 active:text-accent active:scale-95 transition-all">
          <NavIcon d={icons.files} />
          <span className="text-[9px] leading-none">Files</span>
        </button>

        <button onClick={onOpenSearch} className="flex flex-col items-center gap-px text-text-3 active:text-accent active:scale-95 transition-all">
          <NavIcon d={icons.search} />
          <span className="text-[9px] leading-none">{t('nav.search')}</span>
        </button>

        <button onClick={onOpenSettings} className="flex flex-col items-center gap-px text-text-3 active:text-accent active:scale-95 transition-all relative">
          <div className="relative">
            <NavIcon d={icons.settings} />
            <div className={`absolute -top-1 -right-1.5 w-2.5 h-2.5 rounded-full ${statusColor} ${isRecovering ? 'animate-pulse' : ''} border border-bg-1`} />
          </div>
          <span className="text-[9px] leading-none">{statusText}</span>
        </button>
      </div>
    </div>
  )
}
