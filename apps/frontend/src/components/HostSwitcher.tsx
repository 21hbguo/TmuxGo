'use client'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useHosts } from '@/hooks/useApi'
import { useTranslation } from '@/i18n'

export function HostSwitcher({ mode='desktop' }: { mode?: 'desktop' | 'mobile' }) {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const { data: hosts = [] } = useHosts()
  const { t } = useTranslation()
  const activeHost = hosts.find((host: any) => host.id === activeHostId) || hosts[0]
  if (!activeHost) return null
  const statusClass = activeHost.status === 'online' ? 'bg-accent' : activeHost.status === 'offline' ? 'bg-danger' : 'bg-warn'
  const compact = mode === 'desktop'
  const labelClass = compact ? 'text-[10px] uppercase tracking-[0.16em] text-text-3/80' : 'text-[11px] uppercase tracking-[0.16em] text-text-3/80'
  const frameClass = compact ? 'tmuxgo-control tmuxgo-control-soft mt-1 h-8 rounded-lg px-2' : 'tmuxgo-control tmuxgo-control-soft mt-2 h-10 rounded-lg px-3'
  if (hosts.length <= 1) {
    return (
      <div className="min-w-0">
        <div className={labelClass}>{t('hostSwitcher.label')}</div>
        <div className={`flex min-w-0 items-center gap-2 ${frameClass}`}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass}`} />
          <span className="min-w-0 truncate text-xs text-text-2">{activeHost.name}</span>
        </div>
      </div>
    )
  }
  return (
    <label className="block min-w-0">
      <span className={labelClass}>{t('hostSwitcher.label')}</span>
      <span className={`relative flex min-w-0 items-center gap-2 ${frameClass}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass}`} />
        <select value={activeHostId || activeHost.id} onChange={(event) => setActiveHost(event.target.value)} className="tmuxgo-select tmuxgo-select-inline min-w-0 flex-1 appearance-none pr-5 text-xs">
          {hosts.map((host: any) => <option key={host.id} value={host.id}>{host.name}</option>)}
        </select>
        <span className="pointer-events-none absolute right-2 text-[10px] text-text-3/80">⌄</span>
      </span>
    </label>
  )
}
