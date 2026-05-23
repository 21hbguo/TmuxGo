'use client'

import { useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

interface MobileDrawerProps {
  isOpen: boolean
  onClose: () => void
  type: 'sessions' | 'panes'
}

export function MobileDrawer({ isOpen, onClose, type }: MobileDrawerProps) {
  const { sessions, activeSessionId, setActiveSession, panes, activePaneId, setActivePane } = useConsoleStore()
  const { t } = useTranslation()

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute bottom-14 left-0 right-0 bg-bg-1 border-t border-[var(--line)] rounded-t-xl max-h-[60vh] overflow-hidden">
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-text-1 font-medium">
              {type === 'sessions' ? t('drawer.sessions') : t('drawer.panes')}
            </h3>
            <button onClick={onClose} className="text-text-3">✕</button>
          </div>

          <div className="space-y-2 overflow-y-auto max-h-[40vh]">
            {type === 'sessions' && sessions.map((session: any) => (
              <button
                key={session.id}
                onClick={() => {
                  setActiveSession(session.id)
                  onClose()
                }}
                className={`w-full p-3 rounded-lg text-left ${
                  activeSessionId === session.id ? 'bg-accent/20 border border-accent' : 'bg-bg-2'
                }`}
              >
                <div className="text-text-1">{session.name}</div>
                <div className="text-text-3 text-xs">{t('drawer.windows', { count: session.windowCount })}</div>
              </button>
            ))}

            {type === 'panes' && panes.map((pane: any) => (
              <button
                key={pane.id}
                onClick={() => {
                  setActivePane(pane.id)
                  onClose()
                }}
                className={`w-full p-3 rounded-lg text-left ${
                  activePaneId === pane.id ? 'bg-accent/20 border border-accent' : 'bg-bg-2'
                }`}
              >
                <div className="text-text-1">#{pane.index} {pane.title}</div>
                <div className="text-text-3 text-xs">{pane.size.cols}×{pane.size.rows}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
