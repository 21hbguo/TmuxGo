'use client'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/i18n'
import { useAuditLog } from '@/hooks/useApi'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'

interface AuditLogProps {
  onClose: () => void
}
export function AuditLog({ onClose }: AuditLogProps) {
  const [result, setResult] = useState<'' | 'success' | 'failure'>('')
  const [query, setQuery] = useState('')
  const { t } = useTranslation()
  const { data, isLoading, isError, refetch } = useAuditLog(result ? { result } : {})
  const logs = useMemo(() => (data?.events || []).filter((event) => !query.trim() || `${event.action} ${event.target} ${event.hostId || ''}`.toLowerCase().includes(query.trim().toLowerCase())), [data?.events, query])
  return <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-[820px] flex-col overflow-hidden rounded-apple border border-[var(--line)] bg-bg-1" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--line)] p-4">
          <div><h2 className="text-lg font-medium text-text-1">{t('audit.title')}</h2><p className="mt-1 text-sm text-text-3">{t('audit.desc')}</p></div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="close">✕</Button>
        </div>
        <div className="flex gap-2 border-b border-[var(--line)] p-3">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search.placeholder')} className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-3 py-1.5 text-sm" />
          <select value={result} onChange={(event) => setResult(event.target.value as '' | 'success' | 'failure')} className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm"><option value="">{t('audit.result')}</option><option value="success">{t('audit.success')}</option><option value="failure">{t('audit.failure')}</option></select>
          <Button size="sm" onClick={() => void refetch()}>{t('common.retry')}</Button>
        </div>
        <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-auto">
          {isLoading && <div className="p-6 text-center text-sm text-text-3">{t('common.loading')}</div>}
          {isError && <div className="p-6 text-center text-sm text-danger">{t('session.loadFailed')}</div>}
          {!isLoading && !isError && !logs.length && <div className="p-6 text-center text-sm text-text-3">{t('audit.empty')}</div>}
          {!!logs.length && <table className="w-full"><thead><tr className="border-b border-[var(--line)]"><th className="p-3 text-left text-xs font-medium text-text-3">{t('audit.time')}</th><th className="p-3 text-left text-xs font-medium text-text-3">{t('audit.action')}</th><th className="p-3 text-left text-xs font-medium text-text-3">{t('audit.target')}</th><th className="p-3 text-left text-xs font-medium text-text-3">{t('audit.result')}</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id} className="border-b border-[var(--line)] hover:bg-bg-2"><td className="whitespace-nowrap p-3 text-xs text-text-2">{new Date(log.timestamp).toLocaleString()}</td><td className="p-3 font-mono text-xs text-text-1">{log.action}</td><td className="max-w-[360px] truncate p-3 text-sm text-text-2" title={log.target}>{log.target}</td><td className="p-3"><span className={`rounded-apple px-2 py-0.5 text-xs ${log.result === 'success' ? 'bg-accent-2/20 text-accent-2' : 'bg-danger/20 text-danger'}`}>{t(`audit.${log.result}`)}</span></td></tr>)}</tbody></table>}
        </div>
        <div className="flex justify-end border-t border-[var(--line)] p-4"><Button size="sm" onClick={onClose}>{t('audit.close')}</Button></div>
      </div>
    </div>
  </ModalPortal>
}
