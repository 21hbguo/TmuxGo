'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'

interface Notification {
  id: string
  paneId: string
  paneName: string
  message: string
  timestamp: Date
}

export function PaneNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [watchedPanes, setWatchedPanes] = useState<Set<string>>(new Set())
  const { panes, activePaneId } = useConsoleStore()

  useEffect(() => {
    const stored = localStorage.getItem('tmuxu-watched-panes')
    if (stored) setWatchedPanes(new Set(JSON.parse(stored)))
  }, [])

  const toggleWatch = (paneId: string) => {
    const updated = new Set(watchedPanes)
    if (updated.has(paneId)) {
      updated.delete(paneId)
    } else {
      updated.add(paneId)
    }
    setWatchedPanes(updated)
    localStorage.setItem('tmuxu-watched-panes', JSON.stringify(Array.from(updated)))
  }

  const addNotification = useCallback((paneId: string, message: string) => {
    const pane = panes.find((p: any) => p.id === paneId)
    if (!pane) return

    const notification: Notification = {
      id: Date.now().toString(),
      paneId,
      paneName: pane.title || `Pane ${pane.index}`,
      message: message.slice(0, 100),
      timestamp: new Date(),
    }

    setNotifications((prev) => [notification, ...prev.slice(0, 49)])

    if (Notification.permission === 'granted') {
      new Notification(`tmuxU: ${notification.paneName}`, {
        body: notification.message,
      })
    }
  }, [panes])

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }

  const clearAll = () => {
    setNotifications([])
  }

  return (
    <div className="fixed bottom-16 right-4 z-50 w-80">
      {notifications.length > 0 && (
        <div className="bg-bg-1 border border-[var(--line)] rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-[var(--line)] flex items-center justify-between">
            <span className="text-text-2 text-xs">Notifications</span>
            <button onClick={clearAll} className="text-text-3 text-xs hover:text-text-1">
              Clear all
            </button>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {notifications.slice(0, 5).map((n) => (
              <div key={n.id} className="p-2 border-b border-[var(--line)] hover:bg-bg-2">
                <div className="flex items-center justify-between">
                  <span className="text-accent text-xs">{n.paneName}</span>
                  <button
                    onClick={() => dismissNotification(n.id)}
                    className="text-text-3 hover:text-text-1"
                  >
                    ×
                  </button>
                </div>
                <div className="text-text-1 text-sm mt-1">{n.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function WatchButton({ paneId }: { paneId: string }) {
  const [isWatched, setIsWatched] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('tmuxu-watched-panes')
    if (stored) {
      const watched = JSON.parse(stored)
      setIsWatched(watched.includes(paneId))
    }
  }, [paneId])

  const toggle = () => {
    const stored = localStorage.getItem('tmuxu-watched-panes')
    const watched: string[] = stored ? JSON.parse(stored) : []
    const updated = isWatched ? watched.filter((id) => id !== paneId) : [...watched, paneId]
    localStorage.setItem('tmuxu-watched-panes', JSON.stringify(updated))
    setIsWatched(!isWatched)
  }

  return (
    <button
      onClick={toggle}
      className={`p-1 rounded text-xs ${isWatched ? 'text-accent' : 'text-text-3'}`}
      title={isWatched ? 'Unwatch' : 'Watch for notifications'}
    >
      {isWatched ? '🔔' : '🔕'}
    </button>
  )
}
