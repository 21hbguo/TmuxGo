'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n'
import { useSystemInfo, type SystemInfo } from '@/hooks/useSystemInfo'
import { useHosts } from '@/hooks/useApi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { Button } from './Button'

const HISTORY_LEN = 60
const gb = (mb: number) => (mb / 1024).toFixed(1)
const fmtBytes = (n: number) => {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${Math.round(n)} B`
}
const fmtRate = (n: number) => `${fmtBytes(n)}/s`
type Tone = 'warn' | 'danger' | 'neutral'
const toneText: Record<Tone, string> = {
  warn: 'text-warn',
  danger: 'text-danger',
  neutral: 'text-text-1',
}
const toneBar: Record<Tone, string> = {
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-accent',
}
const resourceTone = (used: number, total: number): Tone => {
  const ratio = total > 0 ? used / total : 0
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.75) return 'warn'
  return 'neutral'
}
const pctTone = (pct: number): Tone => {
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warn'
  return 'neutral'
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
interface HistorySample {
  t: number
  cpu: number
  memPct: number
  gpuPct: number | null
  socketBufferedBytes: number
  activeClients: number
  outputBytes: number
  backpressureSignals: number
  droppedOutputChars: number
  outputRate: number
  backpressureRate: number
  netSentBytes: number
  netRecvBytes: number
  netSentRate: number
  netRecvRate: number
}
function streamOf(info: SystemInfo) {
  const s = info.stream || ({} as SystemInfo['stream'])
  return {
    outputBytes: num(s.outputBytes),
    outputChunks: num(s.outputChunks),
    outputFlushes: num(s.outputFlushes),
    outputResyncRequests: num(s.outputResyncRequests),
    outputResyncCompleted: num(s.outputResyncCompleted),
    droppedOutputChars: num(s.droppedOutputChars),
    sanitizeCalls: num(s.sanitizeCalls),
    sanitizeChars: num(s.sanitizeChars),
    attachRequests: num(s.attachRequests),
    snapshotRequests: num(s.snapshotRequests),
    resizeRequests: num(s.resizeRequests),
    inputMessages: num(s.inputMessages),
    backpressureSignals: num(s.backpressureSignals),
    profileUpdates: num(s.profileUpdates),
    deferredFlushes: num(s.deferredFlushes),
    socketBufferedBytes: num(s.socketBufferedBytes),
    activeClients: num(s.activeClients),
    activeProfile: s.activeProfile === 'background' || s.activeProfile === 'mobile' ? s.activeProfile : 'foreground',
    activeFlushInterval: num(s.activeFlushInterval),
    activeMaxChars: num(s.activeMaxChars),
  }
}
function Sparkline({ values, width = 140, height = 36, stroke = 'rgb(var(--accent))' }: { values: number[]; width?: number; height?: number; stroke?: string }) {
  if (values.length < 2) {
    return <div className="flex h-9 items-center text-caption text-text-3">—</div>
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width
    const y = height - ((value - min) / range) * (height - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible" aria-hidden>
      <polyline fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" points={points} />
    </svg>
  )
}
function ProgressBar({ ratio, tone }: { ratio: number; tone: Tone }) {
  const pct = Math.max(0, Math.min(100, ratio * 100))
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-0">
      <div className={`h-full rounded-full ${toneBar[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
function MetricCard({ title, value, sub, tone = 'neutral', series, unit }: { title: string; value: string; sub?: string; tone?: Tone; series?: number[]; unit?: string }) {
  return (
    <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-caption uppercase tracking-[0.12em] text-text-3">{title}</div>
          <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${toneText[tone]}`}>{value}{unit ? <span className="ml-1 text-xs font-normal text-text-3">{unit}</span> : null}</div>
          {sub ? <div className="mt-1 text-caption text-text-3">{sub}</div> : null}
        </div>
        {series ? <Sparkline values={series} stroke={tone === 'danger' ? 'rgb(var(--danger))' : tone === 'warn' ? 'rgb(var(--warn))' : 'rgb(var(--accent))'} /> : null}
      </div>
    </div>
  )
}
function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-text-3">{label}</span>
      <span className="font-mono tabular-nums text-text-1">{value}</span>
    </div>
  )
}

export function SystemHealthPanel() {
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const { data: hosts = [] } = useHosts()
  const [hostId, setHostId] = useState(activeHostId || 'local')
  const [refreshToken, setRefreshToken] = useState(0)
  const [pageVisible, setPageVisible] = useState(typeof document === 'undefined' ? true : document.visibilityState === 'visible')
  const [history, setHistory] = useState<HistorySample[]>([])
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const interval = hostId === 'local' ? 1000 : 2500
  const info = useSystemInfo(hostId, interval, pageVisible, refreshToken)
  const hostOptions = useMemo(() => {
    const map = new Map<string, string>()
    map.set('local', 'local')
    for (const host of hosts as Array<{ id: string; name?: string }>) {
      if (host?.id) map.set(host.id, host.name || host.id)
    }
    if (activeHostId && !map.has(activeHostId)) map.set(activeHostId, activeHostId)
    return Array.from(map.entries())
  }, [hosts, activeHostId])
  useEffect(() => {
    if (activeHostId) setHostId(activeHostId)
  }, [activeHostId])
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  useEffect(() => {
    setHistory([])
    setUpdatedAt(null)
  }, [hostId])
  useEffect(() => {
    if (!info) return
    const stream = streamOf(info)
    const net = info.net || { sentBytes: 0, recvBytes: 0 }
    const now = Date.now()
    setUpdatedAt(now)
    setHistory((prev) => {
      const last = prev[prev.length - 1]
      const dt = last ? Math.max(0.001, (now - last.t) / 1000) : 0
      const sample: HistorySample = {
        t: now,
        cpu: num(info.cpu),
        memPct: info.mem.total > 0 ? (info.mem.used / info.mem.total) * 100 : 0,
        gpuPct: info.gpu && info.gpu.total > 0 ? (info.gpu.used / info.gpu.total) * 100 : null,
        socketBufferedBytes: stream.socketBufferedBytes,
        activeClients: stream.activeClients,
        outputBytes: stream.outputBytes,
        backpressureSignals: stream.backpressureSignals,
        droppedOutputChars: stream.droppedOutputChars,
        outputRate: last ? Math.max(0, (stream.outputBytes - last.outputBytes) / dt) : 0,
        backpressureRate: last ? Math.max(0, (stream.backpressureSignals - last.backpressureSignals) / dt) : 0,
        netSentBytes: net.sentBytes,
        netRecvBytes: net.recvBytes,
        netSentRate: last ? Math.max(0, (net.sentBytes - last.netSentBytes) / dt) : 0,
        netRecvRate: last ? Math.max(0, (net.recvBytes - last.netRecvBytes) / dt) : 0,
      }
      return [...prev, sample].slice(-HISTORY_LEN)
    })
  }, [info])
  const stream = info ? streamOf(info) : null
  const series = (pick: (sample: HistorySample) => number | null | undefined) => history.map(pick).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const missingDependencies = info ? Object.entries(info.dependencies || {}).filter(([, ok]) => !ok).map(([name]) => name) : []
  const disks = info ? [...(info.disks || [])].sort((a, b) => b.used - a.used) : []
  const cpuTone = info ? pctTone(info.cpu) : 'neutral'
  const memTone = info ? resourceTone(info.mem.used, info.mem.total) : 'neutral'
  const gpuTone = info?.gpu ? resourceTone(info.gpu.used, info.gpu.total) : 'neutral'
  const bufferTone = stream && stream.socketBufferedBytes >= 1024 * 1024 ? 'danger' : stream && stream.socketBufferedBytes >= 256 * 1024 ? 'warn' : 'neutral'
  const backpressureTone = stream && stream.backpressureSignals > 0 ? (stream.backpressureSignals >= 20 ? 'danger' : 'warn') : 'neutral'
  const droppedTone = stream && stream.droppedOutputChars > 0 ? 'warn' : 'neutral'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-apple border border-[var(--line)] bg-bg-2 p-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-1">{t('settings.performanceTitle')}</div>
          <div className="mt-1 text-caption text-text-3">{t('settings.performanceDesc')}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={hostId} onChange={(event) => setHostId(event.target.value)} className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm" aria-label={t('settings.performanceHost')}>
            {hostOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <Button size="sm" onClick={() => setRefreshToken((value) => value + 1)}>{t('settings.performanceRefresh')}</Button>
        </div>
      </div>
      <div className="flex items-center justify-between text-caption text-text-3">
        <span>{t('settings.performanceUpdated')}: {updatedAt ? new Date(updatedAt).toLocaleTimeString() : '—'}</span>
        <span>{hostId === 'local' ? t('settings.performanceIntervalLocal') : t('settings.performanceIntervalRemote')}</span>
      </div>
      {!info && <div className="rounded-apple border border-[var(--line)] p-4 text-sm text-text-3">{t('common.loading')}</div>}
      {info && (
        <>
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-1">{t('settings.performanceResources')}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-caption uppercase tracking-[0.12em] text-text-3">CPU</div>
                    <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${toneText[cpuTone]}`}>{info.cpu}%</div>
                  </div>
                  <Sparkline values={series((sample) => sample.cpu)} stroke={cpuTone === 'danger' ? 'rgb(var(--danger))' : cpuTone === 'warn' ? 'rgb(var(--warn))' : 'rgb(var(--accent))'} />
                </div>
                <ProgressBar ratio={info.cpu / 100} tone={cpuTone} />
              </div>
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-caption uppercase tracking-[0.12em] text-text-3">MEM</div>
                    <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${toneText[memTone]}`}>{gb(info.mem.used)}/{gb(info.mem.total)}G</div>
                    <div className="mt-1 text-caption text-text-3">{info.mem.total > 0 ? `${Math.round((info.mem.used / info.mem.total) * 100)}%` : '—'}</div>
                  </div>
                  <Sparkline values={series((sample) => sample.memPct)} stroke={memTone === 'danger' ? 'rgb(var(--danger))' : memTone === 'warn' ? 'rgb(var(--warn))' : 'rgb(var(--accent))'} />
                </div>
                <ProgressBar ratio={info.mem.total > 0 ? info.mem.used / info.mem.total : 0} tone={memTone} />
              </div>
              {info.gpu && (
                <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-caption uppercase tracking-[0.12em] text-text-3">GPU</div>
                      <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${toneText[gpuTone]}`}>{gb(info.gpu.used)}/{gb(info.gpu.total)}G</div>
                      <div className="mt-1 text-caption text-text-3">{info.gpu.total > 0 ? `${Math.round((info.gpu.used / info.gpu.total) * 100)}%` : '—'}</div>
                    </div>
                    <Sparkline values={series((sample) => sample.gpuPct)} stroke={gpuTone === 'danger' ? 'rgb(var(--danger))' : gpuTone === 'warn' ? 'rgb(var(--warn))' : 'rgb(var(--accent))'} />
                  </div>
                  <ProgressBar ratio={info.gpu.total > 0 ? info.gpu.used / info.gpu.total : 0} tone={gpuTone} />
                </div>
              )}
              <MetricCard title={t('settings.performanceActiveClients')} value={String(stream?.activeClients ?? 0)} series={series((sample) => sample.activeClients)} sub={stream ? `${t('settings.performanceProfile')}: ${stream.activeProfile}` : undefined} />
            </div>
          </div>
          {disks.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-1">{t('settings.performanceDisks')}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {disks.map((disk) => {
                  const tone = resourceTone(disk.used, disk.total)
                  return (
                    <div key={disk.mount} className="rounded-apple border border-[var(--line)] bg-bg-2 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate font-mono text-sm text-text-1" title={disk.mount}>{disk.mount}</div>
                        <div className={`font-mono text-sm tabular-nums ${toneText[tone]}`}>{gb(disk.used)}/{gb(disk.total)}G</div>
                      </div>
                      <ProgressBar ratio={disk.total > 0 ? disk.used / disk.total : 0} tone={tone} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-1">{t('settings.performanceStream')}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MetricCard title={t('settings.performanceOutputRate')} value={fmtRate(history[history.length - 1]?.outputRate || 0)} series={series((sample) => sample.outputRate)} sub={`${t('settings.performanceTotal')}: ${fmtBytes(stream?.outputBytes || 0)}`} />
              <MetricCard title={t('settings.performanceNetSent')} value={fmtRate(history[history.length - 1]?.netSentRate || 0)} series={series((sample) => sample.netSentRate)} sub={`${t('settings.performanceTotal')}: ${fmtBytes(info?.net?.sentBytes || 0)}`} />
              <MetricCard title={t('settings.performanceNetRecv')} value={fmtRate(history[history.length - 1]?.netRecvRate || 0)} series={series((sample) => sample.netRecvRate)} sub={`${t('settings.performanceTotal')}: ${fmtBytes(info?.net?.recvBytes || 0)}`} />
              <MetricCard title={t('settings.performanceSocketBuffer')} value={fmtBytes(stream?.socketBufferedBytes || 0)} series={series((sample) => sample.socketBufferedBytes)} tone={bufferTone} />
              <MetricCard title={t('settings.performanceBackpressure')} value={String(stream?.backpressureSignals || 0)} series={series((sample) => sample.backpressureSignals)} tone={backpressureTone} sub={`${t('settings.performanceRate')}: ${(history[history.length - 1]?.backpressureRate || 0).toFixed(2)}/s`} />
              <MetricCard title={t('settings.performanceDropped')} value={String(stream?.droppedOutputChars || 0)} series={series((sample) => sample.droppedOutputChars)} tone={droppedTone} />
            </div>
            <div className="mt-3 rounded-apple border border-[var(--line)] bg-bg-2 px-3 py-2">
              <StatRow label={t('settings.performanceFlushInterval')} value={`${stream?.activeFlushInterval ?? 0} ms`} />
              <StatRow label={t('settings.performanceMaxChars')} value={stream?.activeMaxChars ?? 0} />
              <StatRow label={t('settings.performanceFlushes')} value={stream?.outputFlushes ?? 0} />
              <StatRow label={t('settings.performanceChunks')} value={stream?.outputChunks ?? 0} />
              <StatRow label={t('settings.performanceInput')} value={stream?.inputMessages ?? 0} />
              <StatRow label={t('settings.performanceDeferred')} value={stream?.deferredFlushes ?? 0} />
              <StatRow label={t('settings.performanceResync')} value={`${stream?.outputResyncCompleted ?? 0}/${stream?.outputResyncRequests ?? 0}`} />
              <StatRow label={t('settings.performanceAttach')} value={stream?.attachRequests ?? 0} />
              <StatRow label={t('settings.performanceCompressFrames')} value={stream?.compressFrames ?? 0} />
              <StatRow label={t('settings.performanceCompressSaved')} value={fmtBytes(Math.max(0, (stream?.compressBytesIn ?? 0) - (stream?.compressBytesOut ?? 0)))} />
              <StatRow label={t('settings.performanceCellSnapshots')} value={stream?.cellSnapshots ?? 0} />
              <StatRow label={t('settings.performanceCellDiffs')} value={stream?.cellDiffs ?? 0} />
              <StatRow label={t('settings.performanceCellFallback')} value={stream?.cellFallbackAnsi ?? 0} />
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-1">{t('settings.performanceDependencies')}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {Object.entries(info.dependencies || {}).map(([name, ok]) => (
                <div key={name} className={`rounded-apple border px-2 py-2 text-center text-sm ${ok ? 'border-accent-2/30 bg-accent-2/10 text-accent-2' : 'border-danger/30 bg-danger/10 text-danger'}`}>
                  <div className="font-mono">{name}</div>
                  <div className="mt-1 text-caption">{ok ? t('settings.performanceDepOk') : t('settings.performanceDepMissing')}</div>
                </div>
              ))}
            </div>
            {missingDependencies.length > 0 && <div className="mt-2 text-caption text-warn">{t('settings.performanceDepWarn', { list: missingDependencies.join(', ') })}</div>}
          </div>
        </>
      )}
    </div>
  )
}
