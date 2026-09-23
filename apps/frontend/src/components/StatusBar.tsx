'use client'

import { useState, useRef, useEffect } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { useSystemInfo } from '@/hooks/useSystemInfo'
import { useHosts, useSessions, useSessionSnapshot } from '@/hooks/useApi'
import { Chip } from './Chip'
import { AgentStatusBadge } from './AgentStatusBadge'
import { subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { getNetStats } from '@/lib/net-stats'

const gb = (mb: number) => (mb / 1024).toFixed(1)
const SESSION_SYNC_DELAY_MS = 15000
const AGENT_MONITOR_ERROR_TTL_MS = 5000
type Tone = 'success' | 'warn' | 'danger' | 'neutral'
const chipTone: Record<Tone, string> = {
  success: 'bg-accent-2/10 text-accent-2',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-2/40 text-text-2',
}
const resourceTone = (used: number, total: number): Tone => {
  const ratio = total > 0 ? used / total : 0
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.75) return 'warn'
  return 'neutral'
}
function ResourceChip({
  label,
  value,
  tone = 'neutral',
  title,
}: {
  label: string
  value: string
  tone?: Tone
  title?: string
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-5 items-center gap-1.5 rounded-md px-2 font-mono tabular-nums ${chipTone[tone]}`}
    >
      <span className="text-caption font-medium uppercase tracking-[0.16em] text-text-3">{label}</span>
      <span className="text-caption font-semibold">{value}</span>
    </span>
  )
}

function formatTraffic(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${Math.round(bytes)}B`
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

// Integer percentages render without decimals; fractional ones are capped at 1 decimal.
function formatLoss(pct: number): string {
  return `${Number(pct.toFixed(1))}%`
}

export function StatusBar() {
  const [showAllDisks, setShowAllDisks] = useState(false)
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const connection = useConsoleStore((state) => state.connection)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const { t } = useTranslation()
  const [pageVisible, setPageVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  )
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const sys = useSystemInfo(activeHostId || 'local', 2000, pageVisible)
  const { data: hosts = [] } = useHosts()
  const sessionsQuery = useSessions(activeHostId || '')
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', activeSessionId || '')
  const panes = snapshotData?.panes || []
  const [traffic, setTraffic] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [agentMonitorErrorAt, setAgentMonitorErrorAt] = useState(0)
  const lastBytesRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    setAgentMonitorErrorAt(0)
    const handleAgentMonitorError = (detail: { hostId?: string }) => {
      if (detail?.hostId !== activeHostId) return
      const timestamp = Date.now()
      setAgentMonitorErrorAt(timestamp)
      setNow(timestamp)
    }
    return subscribeStreamEvent(STREAM_EVENT.agentMonitorError, handleAgentMonitorError)
  }, [activeHostId])
  useEffect(() => {
    if (!sys?.stream?.outputBytes) return
    const now = Date.now()
    const elapsed = (now - lastTimeRef.current) / 1000
    if (lastBytesRef.current !== null && elapsed > 0) {
      const bytesPerSec = (sys.stream.outputBytes - lastBytesRef.current) / elapsed
      setTraffic(Math.max(0, bytesPerSec))
    }
    lastBytesRef.current = sys.stream.outputBytes
    lastTimeRef.current = now
  }, [sys?.stream?.outputBytes])

  const activePane = panes.find((p: any) => p.id === activePaneId)
  const activeHost = hosts.find((h: any) => h.id === activeHostId)
  const missingDependencies = sys
    ? Object.entries(sys.dependencies)
        .filter(([, available]) => !available)
        .map(([name]) => name)
    : []
  const disks = sys ? [...sys.disks].sort((a, b) => b.used - a.used) : []
  const visibleDisks = disks.slice(0, 3)
  const sessionSyncSeconds = sessionsQuery.dataUpdatedAt
    ? Math.max(0, Math.floor((now - sessionsQuery.dataUpdatedAt) / 1000))
    : null
  const sessionSyncAge =
    sessionSyncSeconds === null ? t('status.syncPending') : t('status.syncAge', { seconds: sessionSyncSeconds })
  const sessionSyncDelayed = sessionSyncSeconds !== null && sessionSyncSeconds * 1000 >= SESSION_SYNC_DELAY_MS
  const sessionSyncTone: Tone = sessionsQuery.isError
    ? 'danger'
    : sessionSyncDelayed
      ? 'warn'
      : sessionSyncSeconds === null
        ? 'neutral'
        : 'success'
  const sessionSyncTitle = sessionsQuery.isError
    ? t('status.syncFailedTitle', { age: sessionSyncAge })
    : sessionSyncDelayed
      ? t('status.syncDelayedTitle', { age: sessionSyncAge })
      : sessionSyncSeconds === null
        ? t('status.syncPendingTitle')
        : t('status.syncFreshTitle', { age: sessionSyncAge })
  const agentMonitorFailed = agentMonitorErrorAt > 0 && now - agentMonitorErrorAt < AGENT_MONITOR_ERROR_TTL_MS
  const netStats = getNetStats()

  const statusStyle = (
    {
      connected: { dot: 'bg-accent-2', text: 'text-accent-2', shell: 'bg-accent-2/10' },
      attaching: { dot: 'bg-warn animate-pulse', text: 'text-warn', shell: 'bg-warn/10' },
      reconnecting: { dot: 'bg-warn animate-pulse', text: 'text-warn', shell: 'bg-warn/10' },
      disconnected: { dot: 'bg-danger', text: 'text-danger', shell: 'bg-danger/10' },
    } as Record<string, { dot: string; text: string; shell: string }>
  )[connection.status] || { dot: 'bg-text-3', text: 'text-text-3', shell: 'bg-bg-2/40' }

  return (
    <footer
      className="tmuxgo-glass tmuxgo-glass-chrome relative h-7 shrink-0 overflow-visible border-t px-3 text-meta text-text-3"
      style={{ borderTopColor: 'var(--line)', boxShadow: 'none' }}
    >
      <div className="relative flex h-full items-center justify-between gap-3">
        <section aria-label="Workspace context" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {activePane && (
            <span className="inline-flex h-5 items-center rounded-md bg-bg-2/40 px-2 font-mono text-caption tabular-nums text-text-2">
              {activePane.size.cols}×{activePane.size.rows}
            </span>
          )}
          {activePane?.agent && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="max-w-24 truncate text-caption text-text-2">{activePane.agent}</span>
              <AgentStatusBadge status={activePane.agentStatus} />
            </span>
          )}
          {activePane?.display &&
            (activePane.display.title ||
              activePane.display.stateLabel ||
              typeof activePane.display.tokens === 'number') && (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 font-mono text-caption text-text-3"
                title={activePane.display.title || ''}
              >
                <span className="max-w-40 truncate">{activePane.display.stateLabel || activePane.display.title}</span>
                {typeof activePane.display.tokens === 'number' && (
                  <span className="shrink-0 tabular-nums text-accent-2">{activePane.display.tokens}t</span>
                )}
              </span>
            )}
          {activeHost && (
            <span className="min-w-0 truncate rounded-md bg-bg-2/40 px-2 py-0.5 text-caption text-text-2">
              {activeHost.name}
            </span>
          )}
        </section>
        {sys && (
          <section aria-label="System resources" className="flex min-w-0 items-center gap-1.5 overflow-visible">
            {sys.gpu && (
              <ResourceChip
                label="GPU"
                value={`${gb(sys.gpu.used)}/${gb(sys.gpu.total)}G`}
                tone={resourceTone(sys.gpu.used, sys.gpu.total)}
              />
            )}
            {missingDependencies.length > 0 && (
              <ResourceChip
                label="DEP"
                value={String(missingDependencies.length)}
                tone="warn"
                title={missingDependencies.join(', ')}
              />
            )}
            <ResourceChip
              label="CPU"
              value={`${sys.cpu}%`}
              tone={sys.cpu >= 90 ? 'danger' : sys.cpu >= 75 ? 'warn' : 'neutral'}
            />
            <ResourceChip
              label="MEM"
              value={`${gb(sys.mem.used)}/${gb(sys.mem.total)}G`}
              tone={resourceTone(sys.mem.used, sys.mem.total)}
            />
            {visibleDisks.map((d) => (
              <ResourceChip
                key={d.mount}
                label={d.mount}
                value={`${gb(d.used)}/${gb(d.total)}G`}
                tone={resourceTone(d.used, d.total)}
              />
            ))}
            {disks.length > 3 && (
              <div
                className="relative shrink-0"
                onMouseEnter={() => setShowAllDisks(true)}
                onMouseLeave={() => setShowAllDisks(false)}
                onFocus={() => setShowAllDisks(true)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowAllDisks(false)
                }}
              >
                <Chip
                  aria-label="Show all storage"
                  aria-expanded={showAllDisks}
                  title="Show all storage"
                  className="h-5 px-2 font-mono text-caption font-semibold tabular-nums text-text-2 transition-colors hover:text-accent-2"
                >
                  <span>{`+${disks.length - 3}`}</span>
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 -translate-y-0.5 rotate-45 border-b border-r border-current"
                  />
                </Chip>
                {showAllDisks && (
                  <div className="absolute bottom-full right-0 z-50 pb-2" role="list" aria-label="All storage">
                    <div className="min-w-56 tmuxgo-float-surface p-1.5">
                      {disks.map((d) => (
                        <div
                          key={d.mount}
                          role="listitem"
                          className="flex h-6 items-center justify-between gap-5 rounded-apple px-2 font-mono text-caption tabular-nums text-text-2 hover:bg-bg-2/70"
                        >
                          <span className="truncate text-text-3">{d.mount}</span>
                          <span
                            className={
                              resourceTone(d.used, d.total) === 'danger'
                                ? 'text-danger'
                                : resourceTone(d.used, d.total) === 'warn'
                                  ? 'text-warn'
                                  : 'text-text-2'
                            }
                          >{`${gb(d.used)}/${gb(d.total)}G`}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
        <section aria-label="Connection status" className="flex shrink-0 items-center gap-1.5">
          <span aria-label={t('status.sessionSyncStatus')}>
            <ResourceChip
              label={t('status.sessionSync')}
              value={sessionsQuery.isError ? `${t('status.failed')} ${sessionSyncAge}` : sessionSyncAge}
              tone={sessionSyncTone}
              title={sessionSyncTitle}
            />
          </span>
          {agentMonitorFailed && (
            <span aria-label={t('status.hostScanStatus')}>
              <ResourceChip
                label={t('status.host')}
                value={t('status.scanFailed')}
                tone="danger"
                title={t('status.scanFailedTitle')}
              />
            </span>
          )}
          <span aria-label={t('status.netStats')}>
            <ResourceChip
              label={t('status.packets')}
              value={t('status.netStatsValue', {
                tx: formatCount(netStats.tx),
                rx: formatCount(netStats.rx),
                loss: formatLoss(netStats.lossPct),
              })}
              tone="success"
              title={t('status.netStatsTitle', {
                tx: netStats.tx,
                rx: netStats.rx,
                loss: formatLoss(netStats.lossPct),
              })}
            />
          </span>
          <span
            className={`inline-flex h-5 items-center gap-1.5 rounded-md px-2 font-medium ${statusStyle.shell}`}
            style={{ minWidth: '180px' }}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
            <span className={statusStyle.text}>
              {t(`status.${connection.status}`)}
              {connection.status === 'connected' && (
                <>
                  <span className="ml-1 inline-block min-w-[3.2em] font-mono text-right tabular-nums">
                    {connection.latency}ms
                  </span>
                  <span className="mx-1 text-text-3">·</span>
                  <span className="inline-block min-w-[4em] font-mono text-right tabular-nums">
                    {formatTraffic(traffic)}/s
                  </span>
                </>
              )}
            </span>
          </span>
        </section>
      </div>
    </footer>
  )
}
