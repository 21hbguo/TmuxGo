'use client'

import { useMemo, useState } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWindows } from '@/hooks/useApi'
import { api } from '@/lib/api'

export function QuickActions() {
  const { preferences, updatePreferences } = usePreferences()
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const [pendingDirection, setPendingDirection] = useState<'horizontal' | 'vertical' | null>(null)
  const sessionName = activeSessionId?.replace('session-', '') || ''
  const activeWindow = useMemo(() => windowsData.find((window: any) => window.active) || windowsData[0] || null, [windowsData])
  const canSplit = !!sessionName && !!activeWindow && !pendingDirection

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    if (!sessionName || !activeWindow || pendingDirection) return
    setPendingDirection(direction)
    try {
      await api.panes.create(`${sessionName}:${activeWindow.index}`, direction)
    } finally {
      setPendingDirection(null)
    }
  }

  return (
    <div className="grid grid-cols-2 gap-1">
      <button
        onClick={() => handleSplit('horizontal')}
        disabled={!canSplit}
        className={`px-2 py-1.5 rounded text-xs transition-colors ${canSplit ? 'bg-bg-2 text-text-2 hover:bg-bg-1' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}
        title={t('sidebar.splitH')}
      >
        {t('sidebar.splitH')}
      </button>
      <button
        onClick={() => handleSplit('vertical')}
        disabled={!canSplit}
        className={`px-2 py-1.5 rounded text-xs transition-colors ${canSplit ? 'bg-bg-2 text-text-2 hover:bg-bg-1' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}
        title={t('sidebar.splitV')}
      >
        {t('sidebar.splitV')}
      </button>
      <button
        onClick={() => updatePreferences({ attachExclusive: !preferences.attachExclusive })}
        className="col-span-2 px-2 py-1.5 rounded text-xs transition-colors bg-accent/20 text-accent border border-accent/40 hover:bg-accent/25"
        title={t('quick.attachModeTitle')}
      >
        {preferences.attachExclusive ? t('quick.attachExclusive') : t('quick.attachShared')}
      </button>
    </div>
  )
}
