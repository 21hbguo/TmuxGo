'use client'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useHosts } from '@/hooks/useApi'
import type { Host } from '@/types'
import { useTranslation } from '@/i18n'
import { Select } from './Select'

export function HostSwitcher({ mode = 'desktop' }: { mode?: 'desktop' | 'mobile' }) {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const { data: hosts = [] } = useHosts()
  const { t } = useTranslation()
  const activeHost = hosts.find((host: Host) => host.id === activeHostId) || hosts[0]
  if (!activeHost) return null
  const statusClass =
    activeHost.status === 'online' ? 'bg-accent' : activeHost.status === 'offline' ? 'bg-danger' : 'bg-warn'
  const compact = mode === 'desktop'
  const labelClass = compact
    ? 'text-caption uppercase tracking-[0.16em] text-text-3/80'
    : 'text-meta uppercase tracking-[0.16em] text-text-3/80'
  const frameClass = compact
    ? 'tmuxgo-control tmuxgo-control-soft mt-1 h-8 rounded-apple px-2'
    : 'tmuxgo-control tmuxgo-control-soft mt-2 h-10 rounded-apple px-3'
  // desktop 形态统一成「一行主机条」：状态点 + 名称 + 切换，不再叠两行标签，
  // 半宽布局下主机名会被截成 local-mach…，一眼看不出是哪台机器
  if (compact) {
    if (hosts.length <= 1) {
      return (
        <div className="tmuxgo-host-bar" title={t('hostSwitcher.label')}>
          <span className={`tmuxgo-host-dot ${statusClass}`} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{activeHost.name}</span>
          <span className="tmuxgo-micro shrink-0">{t('hostSwitcher.localTag')}</span>
        </div>
      )
    }
    return (
      <label className="tmuxgo-host-bar" title={t('hostSwitcher.label')}>
        <span className={`tmuxgo-host-dot ${statusClass}`} />
        <Select
          variant="inline"
          value={activeHostId || activeHost.id}
          onChange={setActiveHost}
          options={hosts.map((host: Host) => ({ value: host.id, label: host.name }))}
          className="min-w-0 flex-1 text-xs"
          aria-label={t('hostSwitcher.label')}
        />
      </label>
    )
  }
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
        <Select
          variant="inline"
          value={activeHostId || activeHost.id}
          onChange={setActiveHost}
          options={hosts.map((host: Host) => ({ value: host.id, label: host.name }))}
          className="min-w-0 flex-1 text-xs"
          aria-label={t('hostSwitcher.label')}
        />
      </span>
    </label>
  )
}
