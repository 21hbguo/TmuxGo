'use client'

import { useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'

interface WindowItem {
  id: string
  name: string
  index: number
}

export function WindowList() {
  const windows = useConsoleStore((s) => s.windows)
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [draggedItem, setDraggedItem] = useState<WindowItem | null>(null)
  const [dragOverItem, setDragOverItem] = useState<WindowItem | null>(null)

  const sessionWindows = windows.filter((w: any) => w.sessionId === activeSessionId)

  const handleDragStart = (e: React.DragEvent, window: WindowItem) => {
    setDraggedItem(window)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, window: WindowItem) => {
    e.preventDefault()
    setDragOverItem(window)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    if (!draggedItem || !dragOverItem || !activeHostId || !activeSessionId) return
    const reordered = [...sessionWindows]
    const dragIndex = reordered.findIndex((w) => w.id === draggedItem.id)
    const dropIndex = reordered.findIndex((w) => w.id === dragOverItem.id)
    const [removed] = reordered.splice(dragIndex, 1)
    reordered.splice(dropIndex, 0, removed)
    try {
      const result = await api.windows.move(activeHostId, activeSessionId, reordered.map((window) => window.id))
      if (result.windows) {
        useConsoleStore.setState({ windows: result.windows })
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Reorder failed' })
    }
    setDraggedItem(null)
    setDragOverItem(null)
  }

  const handleDragEnd = () => {
    setDraggedItem(null)
    setDragOverItem(null)
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto p-1 bg-bg-1 border-b border-[var(--line)]">
      {sessionWindows.map((window: any) => (
        <div
          key={window.id}
          draggable
          onDragStart={(e) => handleDragStart(e, window)}
          onDragOver={(e) => handleDragOver(e, window)}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
          className={`px-3 py-1.5 rounded text-sm cursor-move transition-colors ${
            draggedItem?.id === window.id
              ? 'opacity-50'
              : dragOverItem?.id === window.id
              ? 'bg-accent/20 border border-accent'
              : 'bg-bg-2 hover:bg-bg-1 text-text-2'
          }`}
        >
          {window.name}
        </div>
      ))}
    </div>
  )
}
