'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'

export function WindowTabs() {
  const { windows, activeSessionId } = useConsoleStore()

  if (!activeSessionId || windows.length === 0) {
    return null
  }

  const sessionWindows = windows.filter((w: any) => w.sessionId === activeSessionId)

  if (sessionWindows.length <= 1) {
    return null
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-bg-1 border-b border-[var(--line)] overflow-x-auto">
      {sessionWindows.map((window: any) => (
        <button
          key={window.id}
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
