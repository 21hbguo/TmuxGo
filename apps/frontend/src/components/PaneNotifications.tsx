'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'

interface Notification {
  id: string
  paneId: string
  paneName: string
  message: string
  timestamp: Date
}

export function PaneNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const { t } = useTranslation()

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }

  const clearAll = () => {
    setNotifications([])
  }

  return (
    <div className="fixed bottom-16 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] lg:bottom-16 bottom-28">
      {notifications.length > 0 && (
        <div className="bg-bg-1 border border-[var(--line)] rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-[var(--line)] flex items-center justify-between">
            <span className="text-text-2 text-xs">{t('notification.title')}</span>
            <button onClick={clearAll} className="text-text-3 text-xs hover:text-text-1">
              {t('notification.clearAll')}
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
  const { t } = useTranslation()

  useEffect(() => {
    const stored = localStorage.getItem('tmuxgo-watched-panes')
    if (stored) {
      const watched = JSON.parse(stored)
      setIsWatched(watched.includes(paneId))
    }
  }, [paneId])

  const toggle = () => {
    const stored = localStorage.getItem('tmuxgo-watched-panes')
    const watched: string[] = stored ? JSON.parse(stored) : []
    const updated = isWatched ? watched.filter((id) => id !== paneId) : [...watched, paneId]
    localStorage.setItem('tmuxgo-watched-panes', JSON.stringify(updated))
    setIsWatched(!isWatched)
  }

  return (
    <button
      onClick={toggle}
      className={`p-1 rounded text-xs ${isWatched ? 'text-accent' : 'text-text-3'}`}
      title={isWatched ? t('notification.unwatch') : t('notification.watch')}
    >
      {isWatched ? '🔔' : '🔕'}
    </button>
  )
}
