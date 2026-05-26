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
  const resolveActivePaneId = async () => {
    if (!activeHostId || !activeSessionId) return useConsoleStore.getState().activePaneId
    const snapshot = await api.snapshot.get(activeHostId, activeSessionId)
    const paneId = snapshot.activePaneId || (snapshot.panes || []).find((pane: any) => pane.active)?.id || useConsoleStore.getState().activePaneId
    useConsoleStore.setState((state) => ({
      windows: snapshot.windows || state.windows,
      panes: snapshot.panes || state.panes,
      activePaneId: paneId || state.activePaneId,
    }))
    return paneId
  }

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    const initialPaneId = await resolveActivePaneId()
    if (!initialPaneId) return
    try {
      await api.panes.split(initialPaneId, direction)
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
    const paneId = await resolveActivePaneId()
    if (!paneId) return
    try {
      await api.panes.kill(paneId)
      await refreshSnapshot()
      pushToast({ type: 'success', message: 'Pane closed' })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Close failed' })
    }
  }

  const handleFullscreen = async () => {
    const paneId = await resolveActivePaneId()
    if (!paneId) return
    const paneElement = document.querySelector(`[data-pane-id="${paneId}"]`)
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
