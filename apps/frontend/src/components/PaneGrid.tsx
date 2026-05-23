'use client'

import { useCallback, useMemo, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useSessionPanes } from '@/hooks/useApi'
import { TerminalPane } from './TerminalPane'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'

interface Window {
  id: string
  sessionId: string
  index: number
  name: string
  active: boolean
}

export function PaneGrid() {
  const { windows, activeHostId, activeSessionId, activePaneId, setActivePane } = useConsoleStore()
  const { send } = useWebSocket()
  const { t } = useTranslation()
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null)

  const { data: sessionPanes = [] } = useSessionPanes(activeHostId || '', activeSessionId || '')

  const activeWindow = useMemo(() => {
    if (windows.length === 0) return null
    return windows.find((w: Window) => w.id === activeWindowId) || windows.find((w: Window) => w.active) || windows[0]
  }, [windows, activeWindowId])

  const panes = useMemo(() => {
    if (sessionPanes.length > 0) {
      return sessionPanes
    }

    if (!activeWindow) return []

    return [{
      id: activeWindow.id,
      windowId: activeWindow.id,
      index: activeWindow.index,
      title: activeWindow.name,
      active: true,
      size: { cols: 80, rows: 24 },
    }]
  }, [sessionPanes, activeWindow])

  const handleInput = useCallback((paneId: string, data: string) => {
    send({
      type: 'input',
      paneId,
      data,
    })
  }, [send])

  if (windows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-3 gap-4">
        <div className="text-6xl">⊞</div>
        <div className="text-lg">{t('grid.noWindows')}</div>
        <div className="text-sm">{t('grid.selectSession')}</div>
      </div>
    )
  }

  const cols = Math.ceil(Math.sqrt(panes.length))
  const rows = Math.ceil(panes.length / cols)

  return (
    <div className="h-full p-2">
      <div
        className="h-full gap-2"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
        }}
      >
        {panes.map((pane: any) => (
          <TerminalPane
            key={pane.id}
            pane={pane}
            isActive={activePaneId === pane.id}
            onClick={() => setActivePane(pane.id)}
            onInput={(data) => handleInput(pane.id, data)}
            windows={windows}
            activeWindowId={activeWindowId || activeWindow?.id}
            onWindowChange={setActiveWindowId}
          />
        ))}
      </div>
    </div>
  )
}
