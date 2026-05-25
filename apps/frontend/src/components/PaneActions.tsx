'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'

export function PaneActions() {
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const refreshSnapshot = async () => {
    if (!activeHostId || !activeSessionId) return
    const snapshot = await api.snapshot.get(activeHostId, activeSessionId)
    useConsoleStore.setState((state) => ({
      windows: snapshot.windows || [],
      panes: snapshot.panes || [],
      activePaneId: (snapshot.panes || []).find((pane: any) => pane.active)?.id || ((snapshot.panes || []).some((pane: any) => pane.id === state.activePaneId) ? state.activePaneId : snapshot.activePaneId || snapshot.panes?.[0]?.id || null),
    }))
  }

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    if (!activePaneId) return
    try {
      await api.panes.split(activePaneId, direction)
      await refreshSnapshot()
      pushToast({ type: 'success', message: 'Pane split complete' })
    } catch (err) {
      try {
        await refreshSnapshot()
        const paneId = useConsoleStore.getState().activePaneId
        if (!paneId || paneId === activePaneId) throw err
        await api.panes.split(paneId, direction)
        await refreshSnapshot()
        pushToast({ type: 'success', message: 'Pane split complete' })
      } catch (retryErr) {
        pushToast({ type: 'error', message: retryErr instanceof Error ? retryErr.message : 'Split failed' })
      }
    }
  }

  const handleClose = async () => {
    if (!activePaneId) return
    try {
      await api.panes.kill(activePaneId)
      await refreshSnapshot()
      pushToast({ type: 'success', message: 'Pane closed' })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Close failed' })
    }
  }

  const handleFullscreen = () => {
    if (!activePaneId) return
    const paneElement = document.querySelector(`[data-pane-id="${activePaneId}"]`)
    if (paneElement) {
      paneElement.requestFullscreen?.()
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => handleSplit('horizontal')}
        className="p-1.5 hover:bg-bg-2 rounded text-text-3 text-xs"
        title="Split Horizontal"
      >
        ◧
      </button>
      <button
        onClick={() => handleSplit('vertical')}
        className="p-1.5 hover:bg-bg-2 rounded text-text-3 text-xs"
        title="Split Vertical"
      >
        ◨
      </button>
      <button
        onClick={handleFullscreen}
        className="p-1.5 hover:bg-bg-2 rounded text-text-3 text-xs"
        title="Fullscreen"
      >
        ⛶
      </button>
      <div className="w-px h-4 bg-[var(--line)] mx-1" />
      <button
        onClick={handleClose}
        className="p-1.5 hover:bg-bg-2 rounded text-danger text-xs"
        title="Close Pane"
      >
        ×
      </button>
    </div>
  )
}
