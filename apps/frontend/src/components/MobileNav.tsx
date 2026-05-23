'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

interface MobileNavProps {
  onOpenDrawer: (type: 'sessions' | 'panes') => void
  onOpenSettings: () => void
}

export function MobileNav({ onOpenDrawer, onOpenSettings }: MobileNavProps) {
  const { toggleCommandPalette } = useConsoleStore()
  const { t } = useTranslation()

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-bg-1 border-t border-[var(--line)] h-14 flex items-center justify-around px-4 z-40">
      <button onClick={() => onOpenDrawer('sessions')} className="flex flex-col items-center gap-0.5 text-text-3">
        <span className="text-lg">☰</span>
        <span className="text-xs">{t('nav.sessions')}</span>
      </button>

      <button onClick={() => onOpenDrawer('panes')} className="flex flex-col items-center gap-0.5 text-text-3">
        <span className="text-lg">⊞</span>
        <span className="text-xs">{t('nav.panes')}</span>
      </button>

      <button onClick={toggleCommandPalette} className="flex flex-col items-center gap-0.5 text-accent">
        <span className="text-lg">⌕</span>
        <span className="text-xs">{t('nav.search')}</span>
      </button>

      <button onClick={onOpenSettings} className="flex flex-col items-center gap-0.5 text-text-3">
        <span className="text-lg">⚙</span>
        <span className="text-xs">{t('nav.settings')}</span>
      </button>
    </div>
  )
}
