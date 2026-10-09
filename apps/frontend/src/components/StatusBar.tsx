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
import { api, type NetTopResponse } from '@/lib/api'
import { useStatusBarPrefs, STATUSBAR_ITEMS, type StatusBarItem } from '@/stores/useStatusBarPrefs'
import { usePreferences } from '@/hooks/usePreferences'
import { FiCommand } from 'react-icons/fi'

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
  const [netRate, setNetRate] = useState({ rx: 0, tx: 0 })
  const [showNetTop, setShowNetTop] = useState(false)
  const [netTop, setNetTop] = useState<NetTopResponse | null>(null)
  const [showCustomize, setShowCustomize] = useState(false)
  const hidden = useStatusBarPrefs((s) => s.hidden)
  const toggleItem = useStatusBarPrefs((s) => s.toggle)
  const { preferences, updatePreferences } = usePreferences()
  const vis = (key: StatusBarItem) => !hidden.includes(key)
  const [now, setNow] = useState(Date.now())
  const [agentMonitorErrorAt, setAgentMonitorErrorAt] = useState(0)
  const lastBytesRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(Date.now())
  const lastNetRef = useRef<{ hostId: string; sent: number; recv: number; t: number } | null>(null)
  const netTopReqRef = useRef(0)
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
  // 被控机网卡速率：sys.net 为累计计数器，按轮询差分得 B/s；换主机时重置基线防尖峰
  useEffect(() => {
    const net = sys?.net
    if (!sys || !net) return
    const now = Date.now()
    const prev = lastNetRef.current
    lastNetRef.current = { hostId: sys.hostId, sent: net.sentBytes, recv: net.recvBytes, t: now }
    if (!prev || prev.hostId !== sys.hostId) {
      setNetRate({ rx: 0, tx: 0 })
      return
    }
    const elapsed = (now - prev.t) / 1000
    if (elapsed <= 0) return
    setNetRate({
      rx: Math.max(0, (net.recvBytes - prev.recv) / elapsed),
      tx: Math.max(0, (net.sentBytes - prev.sent) / elapsed),
    })
  }, [sys])
  const loadNetTop = () => {
    const req = ++netTopReqRef.current
    api.system
      .netTop(activeHostId || 'local')
      .then((data) => {
        if (netTopReqRef.current === req) setNetTop(data)
      })
      .catch(() => {
        if (netTopReqRef.current === req) setNetTop({ available: false, processes: [] })
      })
  }

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
      className="tmuxgo-glass tmuxgo-glass-chrome relative z-40 h-7 shrink-0 overflow-visible border-t px-3 text-meta text-text-3"
      style={{ borderTopColor: 'var(--line)', boxShadow: 'none' }}
    >
      {/* z-40：backdrop-filter 使 footer 成为层叠上下文且默认按 0 排序，终端的
          .xterm-helpers(z:5) 会盖住行内浮层，鼠标移向浮层时命中的是 xterm 触发 mouseleave */}
      <div className="relative flex h-full items-center justify-between gap-3">
        {/* 与 SessionPanel 的 dock 开关同一偏好：状态栏与快捷键 dock 互斥占用底部栏位，h-6 不撑高 h-7 */}
        <button
          type="button"
          onClick={() => updatePreferences({ showShortcutBar: !preferences.showShortcutBar })}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-apple transition-colors ${preferences.showShortcutBar ? 'bg-accent/15 text-accent' : 'text-text-3 hover:bg-accent/15 hover:text-accent'}`}
          aria-label={t('shortcut.toggleDock')}
          aria-pressed={preferences.showShortcutBar}
          title={t('shortcut.toggleDock')}
        >
          <FiCommand aria-hidden="true" size={13} />
        </button>
        {vis('context') && (
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
        )}
        {sys && (
          <section aria-label="System resources" className="flex min-w-0 items-center gap-1.5 overflow-visible">
            {vis('net') && (
              <div
                className="relative shrink-0"
                onMouseEnter={() => {
                  setShowNetTop(true)
                  setNetTop(null)
                  loadNetTop()
                }}
                onMouseLeave={() => setShowNetTop(false)}
                onFocus={() => {
                  setShowNetTop(true)
                  setNetTop(null)
                  loadNetTop()
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowNetTop(false)
                }}
              >
                <Chip
                  aria-label={t('status.hostNet')}
                  aria-expanded={showNetTop}
                  title={t('status.hostNet')}
                  className="h-5 gap-1.5 px-2 font-mono text-caption font-semibold tabular-nums text-text-2 transition-colors hover:text-accent-2"
                >
                  <span className="text-caption font-medium uppercase tracking-[0.16em] text-text-3">
                    {t('status.net')}
                  </span>
                  <span>{`↓${formatTraffic(netRate.rx)}/s ↑${formatTraffic(netRate.tx)}/s`}</span>
                </Chip>
                {showNetTop && (
                  <div className="absolute bottom-full left-0 z-50 pb-2" role="list" aria-label={t('status.netTop')}>
                    {/* 实底浮层：终端画面 backdrop-blur 压不住，玻璃透明度会透出字符看不清 */}
                    <div
                      className="min-w-64 tmuxgo-float-surface p-1.5"
                      style={{ background: 'rgb(var(--bg-1))', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
                    >
                      {netTop === null ? (
                        <div className="flex h-6 items-center px-2 text-caption text-text-3">
                          {t('status.netTopLoading')}
                        </div>
                      ) : !netTop.available ? (
                        <div className="flex h-6 items-center px-2 text-caption text-text-3">
                          {t(
                            netTop.mode === 'nopy'
                              ? 'status.netTopNoPython'
                              : netTop.mode === 'nodiag'
                                ? 'status.netTopNoDiag'
                                : 'status.netTopUnsupported',
                          )}
                        </div>
                      ) : netTop.processes.length === 0 ? (
                        <div className="flex h-6 items-center px-2 text-caption text-text-3">
                          {t('status.netTopEmpty')}
                        </div>
                      ) : (
                        netTop.processes.map((p) => (
                          <div
                            key={`${p.name}:${p.pid}`}
                            role="listitem"
                            className="flex h-6 items-center justify-between gap-5 rounded-apple px-2 font-mono text-caption tabular-nums text-text-2 hover:bg-bg-2/70"
                          >
                            <span className="truncate text-text-3">
                              {p.name}
                              <span className="text-text-3/60">:{p.pid}</span>
                            </span>
                            <span className="shrink-0 text-text-2">{`↓${formatTraffic(p.rxBps)}/s ↑${formatTraffic(p.txBps)}/s · ${p.conns}`}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {sys.gpu && vis('gpu') && (
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
            {vis('cpu') && (
              <ResourceChip
                label="CPU"
                value={`${sys.cpu}%`}
                tone={sys.cpu >= 90 ? 'danger' : sys.cpu >= 75 ? 'warn' : 'neutral'}
              />
            )}
            {vis('mem') && (
              <ResourceChip
                label="MEM"
                value={`${gb(sys.mem.used)}/${gb(sys.mem.total)}G`}
                tone={resourceTone(sys.mem.used, sys.mem.total)}
              />
            )}
            {vis('disks') &&
              visibleDisks.map((d) => (
                <ResourceChip
                  key={d.mount}
                  label={d.mount}
                  value={`${gb(d.used)}/${gb(d.total)}G`}
                  tone={resourceTone(d.used, d.total)}
                />
              ))}
            {vis('disks') && disks.length > 3 && (
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
                    {/* 实底浮层：终端画面 backdrop-blur 压不住，玻璃透明度会透出字符看不清 */}
                    <div
                      className="min-w-56 tmuxgo-float-surface p-1.5"
                      style={{ background: 'rgb(var(--bg-1))', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
                    >
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
          {vis('sync') && (
            <span aria-label={t('status.sessionSyncStatus')}>
              <ResourceChip
                label={t('status.sessionSync')}
                value={sessionsQuery.isError ? `${t('status.failed')} ${sessionSyncAge}` : sessionSyncAge}
                tone={sessionSyncTone}
                title={sessionSyncTitle}
              />
            </span>
          )}
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
          {vis('pkt') && (
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
          )}
          {vis('conn') && (
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
          )}
          <div
            className="relative shrink-0"
            onMouseLeave={() => setShowCustomize(false)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowCustomize(false)
            }}
          >
            <Chip
              aria-label={t('statusbar.customize')}
              aria-expanded={showCustomize}
              title={t('statusbar.customize')}
              onClick={() => setShowCustomize((v) => !v)}
              className="h-5 px-1.5 font-mono text-caption font-semibold tabular-nums text-text-2 transition-colors hover:text-accent-2"
            >
              <span aria-hidden="true">···</span>
            </Chip>
            {showCustomize && (
              <div className="absolute bottom-full right-0 z-50 pb-2" role="menu" aria-label={t('statusbar.customize')}>
                {/* 实底浮层：终端画面 backdrop-blur 压不住，玻璃透明度会透出字符看不清 */}
                <div
                  className="min-w-44 tmuxgo-float-surface p-1.5"
                  style={{ background: 'rgb(var(--bg-1))', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
                >
                  {STATUSBAR_ITEMS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={vis(key)}
                      onClick={() => toggleItem(key)}
                      className="flex h-6 w-full items-center justify-between gap-5 rounded-apple px-2 font-mono text-caption tabular-nums text-text-2 hover:bg-bg-2/70"
                    >
                      <span className="truncate">{t(`statusbar.item.${key}`)}</span>
                      <span className={`shrink-0 ${vis(key) ? 'text-accent-2' : 'text-text-3/40'}`} aria-hidden="true">
                        {vis(key) ? '✓' : '·'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </footer>
  )
}
