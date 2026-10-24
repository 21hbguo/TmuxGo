'use client'
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FiCpu, FiRefreshCw, FiSearch, FiX } from 'react-icons/fi'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useFleetClock, useFleetData, useFleetDurationFormatter } from '@/hooks/useFleet'
import { navigateInboxRoute } from '@/lib/inbox-navigation'
import { AgentStatusBadge } from './AgentStatusBadge'
import { AgentRecoveryBadge } from './AgentRecovery'
import { Button } from './Button'
import type { FleetRow } from '@/lib/fleet'

// fleet 总览：跨 host 的扁平 agent 列表，一屏回答「谁在跑、谁卡住、卡了多久、我要不要介入」。
// 数据全来自已存在的接口（docs/architecture/agent-observability-v2.md §3.2）：状态走
// agent_state 推送写进 sessions 缓存，任务号/pane 序号走 pane 列表（冷数据，低频刷）。
// 刻意不做：批量操作、新建 agent、跨 host 拖拽；也不自带定时轮询（§3.5）。
export function FleetPanel({ mode = 'panel', onClose }: { mode?: 'panel' | 'mobile'; onClose?: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const [needsAttention, setNeedsAttention] = useState(true)
  const [hasTaskOnly, setHasTaskOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [hostFilter, setHostFilter] = useState<string[]>([])
  const filters = useMemo(
    () => ({ needsAttention, hasTaskOnly, query, hostIds: hostFilter }),
    [needsAttention, hasTaskOnly, query, hostFilter],
  )
  const { hosts, fleet, loading, refetch, refetchRecovery } = useFleetData({ visible: true, filters })
  const now = useFleetClock(true)
  const formatDuration = useFleetDurationFormatter(now)

  const jumpToPane = async (row: FleetRow) => {
    const result = await navigateInboxRoute(
      { hostId: row.hostId, sessionName: row.sessionName, paneId: row.paneId },
      queryClient,
    )
    // 只上报失败：成功时界面上就是「选中了那个 pane」，再弹 toast 反而吵
    if (result !== 'pane' && result !== 'session') pushToast({ type: 'error', message: t('inbox.targetMissing') })
  }
  const toggleHost = (hostId: string) =>
    setHostFilter((prev) => (prev.includes(hostId) ? prev.filter((id) => id !== hostId) : [...prev, hostId]))

  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--line)] px-3 py-2">
      <label className="relative flex min-w-0 flex-1 items-center">
        <FiSearch aria-hidden="true" size={12} className="absolute left-2 text-text-3" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('fleet.searchPlaceholder')}
          aria-label={t('fleet.searchPlaceholder')}
          className="h-7 w-full min-w-0 rounded-apple border border-[var(--line)] bg-bg-2/45 pl-6 pr-2 text-xs text-text-1 outline-none placeholder:text-text-3 focus:border-accent/40"
        />
      </label>
      <button
        type="button"
        aria-pressed={needsAttention}
        onClick={() => setNeedsAttention((value) => !value)}
        className={`h-7 shrink-0 rounded-apple border px-2 text-caption ${needsAttention ? 'border-danger/35 bg-danger/10 text-danger' : 'border-[var(--line)] bg-bg-2/45 text-text-3'}`}
      >
        {t('fleet.onlyAttention')}
      </button>
      <button
        type="button"
        aria-pressed={hasTaskOnly}
        onClick={() => setHasTaskOnly((value) => !value)}
        className={`h-7 shrink-0 rounded-apple border px-2 text-caption ${hasTaskOnly ? 'border-accent/35 bg-accent/10 text-accent' : 'border-[var(--line)] bg-bg-2/45 text-text-3'}`}
      >
        {t('fleet.onlyTask')}
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={refetch}
        aria-label={t('fleet.refresh')}
        title={t('fleet.refresh')}
      >
        <FiRefreshCw size={13} />
      </Button>
    </div>
  )
  const hostChips = hosts.length > 1 && (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--line)] px-3 py-1.5">
      {hosts.map((host) => {
        const active = hostFilter.includes(host.id)
        return (
          <button
            key={host.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggleHost(host.id)}
            className={`h-6 shrink-0 rounded-full border px-2 text-caption ${active ? 'border-accent/40 bg-accent/10 text-accent' : 'border-[var(--line)] text-text-3'}`}
          >
            {host.name || host.id}
          </button>
        )
      })}
    </div>
  )
  const body = (
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {loading && <div className="px-3 py-6 text-center text-xs text-text-3">…</div>}
      {!loading && fleet.total === 0 && (
        <div className="px-3 py-8 text-center text-xs text-text-3">
          {/* 机器上根本没有 agent → 安装引导；有 agent 只是被筛掉 → 提示放宽条件 */}
          <div>{fleet.available === 0 ? t('fleet.empty') : t('fleet.noMatch')}</div>
          {fleet.available === 0 && <div className="mt-1 text-caption">{t('fleet.emptyHint')}</div>}
        </div>
      )}
      {fleet.groups.map((group) => (
        <section key={group.hostId} aria-label={group.hostName}>
          <header className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-[var(--line)] bg-bg-0/95 px-3 py-1.5 backdrop-blur">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${group.status === 'online' ? 'bg-accent-2' : 'bg-text-3/50'}`}
            />
            <span className="min-w-0 truncate text-caption font-medium text-text-1">{group.hostName}</span>
            {group.channel && group.channel !== 'local' && (
              <span className="shrink-0 rounded border border-[var(--line)] px-1 text-[9px] text-text-3">
                {group.channel}
              </span>
            )}
            {group.unreachable && <span className="shrink-0 text-[9px] text-danger">{t('fleet.disconnected')}</span>}
            <span className="ml-auto shrink-0 text-[9px] text-text-3">{group.rows.length}</span>
          </header>
          {group.rows.map((row) => (
            <div
              key={row.key}
              data-fleet-row={row.key}
              className="flex items-center gap-2 border-b border-[var(--line)]/60 px-3 py-1.5 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => void jumpToPane(row)}
                title={`${row.sessionName} · ${row.tmuxPaneId || row.paneId}`}
                aria-label={`${t('fleet.jump')} ${row.sessionName} ${row.tmuxPaneId || row.paneId}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="min-w-0 truncate text-xs text-text-1">{row.sessionName}</span>
                <span className="shrink-0 font-mono text-caption text-text-3">
                  {row.paneIndex === null ? '—' : row.paneIndex}
                </span>
                <span className="shrink-0 font-mono text-caption text-text-2">{row.agent || '—'}</span>
                <span className="min-w-0 truncate font-mono text-caption text-accent-2">{row.task || '—'}</span>
              </button>
              <AgentStatusBadge status={row.status} />
              <span className="w-8 shrink-0 text-right font-mono text-caption text-text-3">
                {formatDuration(row.since) || '—'}
              </span>
              <span className="min-w-0 shrink-0 truncate text-caption text-text-3" title={row.updatedAt || undefined}>
                {row.lastEvent || '—'}
              </span>
              {row.recovery && (
                <AgentRecoveryBadge hostId={row.hostId} candidates={[row.recovery]} onResumed={refetchRecovery} />
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
  if (mode === 'mobile') {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-apple bg-bg-2 text-accent">
            <FiCpu size={13} />
          </span>
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-text-1">{t('fleet.title')}</div>
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('common.close')}>
              <FiX size={15} />
            </Button>
          )}
        </div>
        {hostChips}
        {toolbar}
        {body}
      </div>
    )
  }
  return (
    <section className="tmuxgo-content-surface flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-apple bg-bg-2 text-accent">
          <FiCpu size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-text-1">{t('fleet.title')}</div>
          <div className="truncate text-caption text-text-3">{t('fleet.subtitle', { count: fleet.total })}</div>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <FiX size={15} />
          </Button>
        )}
      </div>
      {hostChips}
      {toolbar}
      {body}
    </section>
  )
}
