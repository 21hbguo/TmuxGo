'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWebSocket } from '@/hooks/useWebSocket'

export function PaneActions() {
  const { activePaneId, panes } = useConsoleStore()
  const { send } = useWebSocket()

  const handleSplit = (direction: 'horizontal' | 'vertical') => {
    if (!activePaneId) return
    send({
      type: 'split',
      paneId: activePaneId,
      direction,
    })
  }

  const handleClose = () => {
    if (!activePaneId) return
    send({
      type: 'close-pane',
      paneId: activePaneId,
    })
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
