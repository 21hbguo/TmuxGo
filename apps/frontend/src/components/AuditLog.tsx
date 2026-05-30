'use client'

import { useState } from 'react'
import { useTranslation } from '@/i18n'

interface LogEntry {
  id: string
  timestamp: string
  user: string
  action: string
  target: string
  result: 'success' | 'failure'
}

const mockLogs: LogEntry[] = [
  {
    id: '1',
    timestamp: '2026-05-23T15:30:00Z',
    user: 'admin',
    action: 'create-session',
    target: 'session:main',
    result: 'success',
  },
  {
    id: '2',
    timestamp: '2026-05-23T15:25:00Z',
    user: 'admin',
    action: 'split-pane',
    target: 'pane:1',
    result: 'success',
  },
  {
    id: '3',
    timestamp: '2026-05-23T15:20:00Z',
    user: 'admin',
    action: 'delete-session',
    target: 'session:test',
    result: 'success',
  },
]

interface AuditLogProps {
  onClose: () => void
}

export function AuditLog({ onClose }: AuditLogProps) {
  const [logs] = useState<LogEntry[]>(mockLogs)
  const { t } = useTranslation()

  const actionLabels: Record<string, string> = {
    'create-session': t('audit.createSession'),
    'delete-session': t('audit.deleteSession'),
    'split-pane': t('audit.splitPane'),
    'close-pane': t('audit.closePane'),
    'rename-session': t('audit.renameSession'),
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[700px] max-h-[85vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-[var(--line)] flex items-center justify-between">
          <div>
            <h2 className="text-text-1 text-lg font-medium">{t('audit.title')}</h2>
            <p className="text-text-3 text-sm mt-1">{t('audit.desc')}</p>
          </div>
          <button onClick={onClose} className="text-text-3 hover:text-text-1">✕</button>
        </div>

        <div className="overflow-y-auto max-h-[60vh]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--line)]">
                <th className="text-left p-3 text-text-3 text-xs font-medium">{t('audit.time')}</th>
                <th className="text-left p-3 text-text-3 text-xs font-medium">{t('audit.user')}</th>
                <th className="text-left p-3 text-text-3 text-xs font-medium">{t('audit.action')}</th>
                <th className="text-left p-3 text-text-3 text-xs font-medium">{t('audit.target')}</th>
                <th className="text-left p-3 text-text-3 text-xs font-medium">{t('audit.result')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-[var(--line)] hover:bg-bg-2">
                  <td className="p-3 text-text-2 text-xs">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="p-3 text-text-1 text-sm">{log.user}</td>
                  <td className="p-3 text-text-1 text-sm">{actionLabels[log.action] || log.action}</td>
                  <td className="p-3 text-text-2 text-sm font-mono">{log.target}</td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      log.result === 'success' ? 'bg-accent-2/20 text-accent-2' : 'bg-danger/20 text-danger'
                    }`}>
                      {t(`audit.${log.result}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-[var(--line)] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-bg-2 rounded text-text-2 hover:bg-bg-1"
          >
            {t('audit.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
