'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { useWindows } from '@/hooks/useApi'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { useTranslation } from '@/i18n'

export function WindowTabs() {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const { data: windows = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', activeSessionId || '')
  const { t } = useTranslation()

  if (!activeSessionId || windows.length === 0) {
    return null
  }

  const sessionWindows = windows.filter((w: any) => w.sessionId === activeSessionId)
  const handleSelect = async (windowId: string) => {
    if (!activeHostId || !activeSessionId) return
    const previousWindows = getWindows()
    setWindows(previousWindows.map((window: any) => window.sessionId === activeSessionId ? { ...window, active: window.id === windowId } : window))
    try {
      const result = await api.windows.select(activeHostId, activeSessionId, windowId)
      if (result.windows) setWindows(result.windows)
    } catch (err) {
      setWindows(previousWindows)
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.switchFailed') })
    }
  }

  if (sessionWindows.length <= 1) {
    return null
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-bg-1 border-b border-[var(--line)] overflow-x-auto">
      {sessionWindows.map((window: any) => (
        <button
          key={window.id}
          onClick={() => handleSelect(window.id)}
          className={`px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
            window.active
              ? 'bg-accent text-bg-0'
              : 'bg-bg-2 text-text-2 hover:bg-bg-1'
          }`}
        >
          {window.name}
        </button>
      ))}
    </div>
  )
}
