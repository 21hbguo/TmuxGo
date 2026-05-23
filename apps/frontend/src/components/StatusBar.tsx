'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

export function StatusBar() {
  const { activePaneId, panes, connection, activeHostId, hosts } = useConsoleStore()
  const { t } = useTranslation()

  const activePane = panes.find((p: any) => p.id === activePaneId)
  const activeHost = hosts.find((h: any) => h.id === activeHostId)

  const statusColor = {
    connected: 'text-accent-2',
    reconnecting: 'text-warn',
    disconnected: 'text-danger',
  }[connection.status]

  return (
    <footer className="h-7 bg-bg-1 border-t border-[var(--line)] flex items-center px-4 text-xs shrink-0">
      <div className="flex-1 flex items-center gap-4">
        <span className="text-accent-2">RW</span>
        <span className="text-text-3">UTF-8</span>
        {activePane && (
          <span className="text-text-3">
            {activePane.size.cols}×{activePane.size.rows}
          </span>
        )}
        {activeHost && (
          <span className="text-text-3">
            {activeHost.name}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${statusColor.replace('text-', 'bg-')}`} />
          <span className={statusColor}>{t(`status.${connection.status}`)}</span>
        </div>
        <span className="text-text-3">{connection.latency}ms</span>
      </div>
    </footer>
  )
}
