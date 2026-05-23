'use client'

import { useState, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'

interface WindowItem {
  id: string
  name: string
  index: number
}

export function WindowList() {
  const { windows, activeSessionId } = useConsoleStore()
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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (!draggedItem || !dragOverItem) return

    const reordered = [...sessionWindows]
    const dragIndex = reordered.findIndex((w) => w.id === draggedItem.id)
    const dropIndex = reordered.findIndex((w) => w.id === dragOverItem.id)

    const [removed] = reordered.splice(dragIndex, 1)
    reordered.splice(dropIndex, 0, removed)

    const updated = reordered.map((w, i) => ({ ...w, index: i }))
    useConsoleStore.setState((state) => ({
      windows: state.windows.map((w) => {
        const found = updated.find((u) => u.id === w.id)
        return found || w
      }),
    }))

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
