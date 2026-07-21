'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { useSystemInfo } from '@/hooks/useSystemInfo'
import { useHosts, useSessionSnapshot } from '@/hooks/useApi'
import { AgentStatusBadge } from './AgentStatusBadge'

const gb = (mb: number) => (mb / 1024).toFixed(1)
type Tone = 'warn' | 'danger' | 'neutral'
const chipTone: Record<Tone, string> = {
  warn: 'border-warn/30 bg-warn/10 text-warn',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  neutral: 'border-text-1/10 bg-bg-2/45 text-text-2',
}
const resourceTone = (used: number, total: number): Tone => {
  const ratio = total > 0 ? used / total : 0
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.75) return 'warn'
  return 'neutral'
}
function ResourceChip({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: Tone }) {
  return (
    <span className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 font-mono tabular-nums ${chipTone[tone]}`}>
      <span className="text-[9px] font-medium uppercase tracking-[0.16em] text-text-3">{label}</span>
      <span className="text-[10px] font-semibold">{value}</span>
    </span>
  )
}

export function StatusBar() {
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const connection = useConsoleStore((state) => state.connection)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const { t } = useTranslation()
  const sys = useSystemInfo(2000)
  const { data: hosts = [] } = useHosts()
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', activeSessionId || '')
  const panes = snapshotData?.panes || []

  const activePane = panes.find((p: any) => p.id === activePaneId)
  const activeHost = hosts.find((h: any) => h.id === activeHostId)

  const statusStyle = ({
    connected: { dot: 'bg-accent-2', text: 'text-accent-2', shell: 'border-accent-2/25 bg-accent-2/5' },
    attaching: { dot: 'bg-warn animate-pulse', text: 'text-warn', shell: 'border-warn/30 bg-warn/10' },
    reconnecting: { dot: 'bg-warn animate-pulse', text: 'text-warn', shell: 'border-warn/30 bg-warn/10' },
    disconnected: { dot: 'bg-danger', text: 'text-danger', shell: 'border-danger/30 bg-danger/10' },
  } as Record<string, { dot: string; text: string; shell: string }>)[connection.status] || { dot: 'bg-text-3', text: 'text-text-3', shell: 'border-text-1/10 bg-bg-2/45' }

  return (
    <footer className="tmuxgo-glass tmuxgo-glass-chrome relative h-7 shrink-0 overflow-hidden border-t px-3 text-[11px] text-text-3">
      <div className="relative flex h-full items-center justify-between gap-3">
        <section aria-label="Workspace context" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span className="inline-flex h-5 items-center rounded-full border border-accent-2/25 bg-accent-2/10 px-2 font-mono text-[10px] font-semibold tracking-[0.22em] text-accent-2">RW</span>
          <span className="inline-flex h-5 items-center rounded-full border border-text-1/10 bg-bg-2/45 px-2 font-mono text-[10px] tracking-[0.1em] text-text-3">UTF-8</span>
          {activePane && (
            <span className="inline-flex h-5 items-center rounded-full border border-text-1/10 bg-bg-2/45 px-2 font-mono text-[10px] tabular-nums text-text-2">{activePane.size.cols}×{activePane.size.rows}</span>
          )}
          {activePane?.agent && <span className="inline-flex min-w-0 items-center gap-1.5"><span className="max-w-24 truncate text-[10px] text-text-2">{activePane.agent}</span><AgentStatusBadge status={activePane.agentStatus} /></span>}
          {activeHost && (
            <span className="min-w-0 truncate rounded-full border border-text-1/10 bg-bg-2/45 px-2 py-0.5 text-[10px] text-text-2">{activeHost.name}</span>
          )}
        </section>
        {sys && (
          <section aria-label="System resources" className="hidden min-w-0 items-center gap-1.5 overflow-hidden md:flex">
            {sys.gpu && <ResourceChip label="GPU" value={`${gb(sys.gpu.used)}/${gb(sys.gpu.total)}G`} tone={resourceTone(sys.gpu.used, sys.gpu.total)} />}
            <ResourceChip label="CPU" value={`${sys.cpu}%`} tone={sys.cpu >= 90 ? 'danger' : sys.cpu >= 75 ? 'warn' : 'neutral'} />
            <ResourceChip label="MEM" value={`${gb(sys.mem.used)}/${gb(sys.mem.total)}G`} tone={resourceTone(sys.mem.used, sys.mem.total)} />
            {sys.disks.map((d) => <ResourceChip key={d.mount} label={d.mount} value={`${gb(d.used)}/${gb(d.total)}G`} tone={resourceTone(d.used, d.total)} />)}
          </section>
        )}
        <section aria-label="Connection status" className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 font-medium ${statusStyle.shell}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
          <span className={statusStyle.text}>{t(`status.${connection.status}`)}</span>
        </section>
      </div>
    </footer>
  )
}
