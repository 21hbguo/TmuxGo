'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'

export function PaneActions() {
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const pushToast = useConsoleStore((s) => s.pushToast)

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    if (!activePaneId) return
    try {
      await api.panes.split(activePaneId, direction)
      pushToast({ type: 'success', message: 'Pane split complete' })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Split failed' })
    }
  }

  const handleClose = async () => {
    if (!activePaneId) return
    try {
      await api.panes.kill(activePaneId)
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
