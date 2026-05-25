'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

export function ConnectionBadge() {
  const { connection } = useConsoleStore()
  const { t } = useTranslation()

  const statusConfig = {
    connected: {
      color: 'bg-accent-2',
      text: t('badge.connected'),
      pulse: false,
    },
    attaching: {
      color: 'bg-warn',
      text: t('badge.attaching'),
      pulse: true,
    },
    reconnecting: {
      color: 'bg-warn',
      text: t('badge.reconnecting'),
      pulse: true,
    },
    disconnected: {
      color: 'bg-danger',
      text: t('badge.disconnected'),
      pulse: false,
    },
  }

  const config = statusConfig[connection.status]

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-2 rounded-lg">
      <div className="relative">
        <div className={`w-2 h-2 rounded-full ${config.color}`} />
        {config.pulse && (
          <div className={`absolute inset-0 w-2 h-2 rounded-full ${config.color} animate-ping`} />
        )}
      </div>
      <span className="text-text-2 text-xs">{config.text}</span>
      {connection.status === 'connected' && (
        <span className="text-text-3 text-xs">{connection.latency}ms</span>
      )}
    </div>
  )
}
