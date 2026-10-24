'use client'
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FiCpu, FiPlay, FiRefreshCw, FiSearch, FiX } from 'react-icons/fi'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useFleetClock, useFleetData, useFleetDurationFormatter } from '@/hooks/useFleet'
import { navigateInboxRoute } from '@/lib/inbox-navigation'
import { FLEET_ATTENTION_MAX_RANK, fleetRank, type FleetGroup, type FleetRow as FleetRowData } from '@/lib/fleet'
import { AgentStatusBadge } from './AgentStatusBadge'
import { AgentRecoveryBadge } from './AgentRecovery'
import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { FilterToggle } from './FilterToggle'
import { PanelHeader } from './PanelHeader'
import { StatusDot } from './StatusDot'

// fleet 总览：跨 host 的扁平 agent 列表，一屏回答「谁在跑、谁卡住、卡了多久、我要不要介入」。
// 数据全来自已存在的接口（docs/architecture/agent-observability-v2.md §3.2）：状态走
// agent_state 推送写进 sessions 缓存，任务号/pane 序号走 pane 列表（冷数据，低频刷）。
// 刻意不做：批量操作、新建 agent、跨 host 拖拽；也不自带定时轮询（§3.5）。
//
// 结构：面板壳（标题条 + chips + toolbar + body）只负责布局，行/分组头/工具栏/空态各自成组件。
// 共享原语（PanelHeader/FilterToggle/StatusDot）合并进 master 后，这里按同名组件就地替换即可。

type BatchResult = 'ok' | 'error' | 'skipped'

// 行的状态锚点：左侧 2px 色条 + 极淡底色。blocked/failed 共用 danger——一屏扫下来先看到红色，
// done（等你验收）用 accent-2，working 用 accent，其余保持中性不抢注意力。
const ROW_TONE = {
  danger: { bar: 'bg-danger/80', hover: 'hover:bg-danger/[0.08]', row: 'bg-danger/[0.045]' },
  done: { bar: 'bg-accent-2/70', hover: 'hover:bg-bg-2/45', row: '' },
  working: { bar: 'bg-accent/60', hover: 'hover:bg-bg-2/45', row: '' },
  muted: { bar: 'bg-transparent', hover: 'hover:bg-bg-2/40', row: '' },
} as const

function rowTone(row: FleetRowData): keyof typeof ROW_TONE {
  if (fleetRank(row) <= FLEET_ATTENTION_MAX_RANK) return 'danger'
  if (row.status === 'done') return 'done'
  if (row.status === 'working') return 'working'
  return 'muted'
}

function FleetToolbar({
  query,
  onQueryChange,
  needsAttention,
  hasTaskOnly,
  onToggleAttention,
  onToggleTask,
  recoveryCount,
  resumableCount,
  resumeRunning,
  onResumeAll,
  onRefresh,
}: {
  query: string
  onQueryChange: (value: string) => void
  needsAttention: boolean
  hasTaskOnly: boolean
  onToggleAttention: () => void
  onToggleTask: () => void
  recoveryCount: number
  resumableCount: number
  resumeRunning: boolean
  onResumeAll: () => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--line)] px-3 py-2">
      <label className="relative flex min-w-0 flex-1 basis-40 items-center">
        <FiSearch aria-hidden="true" size={12} className="absolute left-2 text-text-3" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('fleet.searchPlaceholder')}
          aria-label={t('fleet.searchPlaceholder')}
          className={cn(
            'h-7 w-full min-w-0 rounded-apple border border-[var(--line)] bg-bg-2/45 pl-6 text-xs text-text-1 outline-none transition-colors placeholder:text-text-3 hover:border-text-3/30 focus:border-accent/45 focus:bg-bg-2/70 focus:ring-2 focus:ring-accent/15 [&::-webkit-search-cancel-button]:appearance-none',
            // 有清除钮时留出它的位置，长查询不会被 X 盖住
            query ? 'pr-7' : 'pr-2',
          )}
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label={t('fleet.clearSearch')}
            title={t('fleet.clearSearch')}
            className="absolute right-1 flex h-5 w-5 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-bg-2/70 hover:text-text-1"
          >
            <FiX size={11} />
          </button>
        )}
      </label>
      <FilterToggle pressed={needsAttention} tone="danger" onClick={onToggleAttention}>
        {t('fleet.onlyAttention')}
      </FilterToggle>
      <FilterToggle pressed={hasTaskOnly} tone="accent" onClick={onToggleTask}>
        {t('fleet.onlyTask')}
      </FilterToggle>
      {recoveryCount > 0 && (
        <button
          type="button"
          onClick={onResumeAll}
          disabled={resumeRunning || !resumableCount}
          title={resumableCount ? t('fleet.batchResumeHint') : t('fleet.batchResumeNone')}
          className="flex h-7 shrink-0 items-center gap-1 rounded-apple border border-accent-2/35 bg-accent-2/10 px-2 text-caption font-medium text-accent-2 transition-colors hover:bg-accent-2/15 disabled:opacity-45"
        >
          <FiPlay aria-hidden="true" size={11} />
          {resumeRunning ? t('fleet.batchResumeRunning') : t('fleet.batchResume', { count: resumableCount })}
        </button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRefresh}
        aria-label={t('fleet.refresh')}
        title={t('fleet.refresh')}
      >
        <FiRefreshCw size={13} />
      </Button>
    </div>
  )
}

function FleetHostChips({
  hosts,
  selected,
  onToggle,
}: {
  hosts: { id: string; name?: string }[]
  selected: string[]
  onToggle: (hostId: string) => void
}) {
  return (
    <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-[var(--line)] px-3 py-1">
      {hosts.map((host) => {
        const active = selected.includes(host.id)
        return (
          <button
            key={host.id}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(host.id)}
            title={host.name || host.id}
            className={cn(
              'h-6 shrink-0 rounded-full border px-2 text-caption transition-colors',
              active
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-[var(--line)] text-text-3 hover:border-text-3/30 hover:text-text-1',
            )}
          >
            {host.name || host.id}
          </button>
        )
      })}
    </div>
  )
}

function FleetGroupHeader({ group }: { group: FleetGroup }) {
  const { t } = useTranslation()
  const online = group.status === 'online'
  return (
    <header className="sticky top-0 z-[1] flex h-8 items-center gap-2 border-b border-[var(--line)] bg-bg-0/85 px-3 backdrop-blur-md">
      <StatusDot tone={online ? 'success' : 'muted'} />
      <span className="min-w-0 truncate text-caption font-semibold tracking-wide text-text-1" title={group.hostName}>
        {group.hostName}
      </span>
      {group.channel && group.channel !== 'local' && (
        <span className="shrink-0 rounded border border-[var(--line)] px-1 text-[9px] leading-4 text-text-3">
          {group.channel}
        </span>
      )}
      {group.unreachable && (
        <span className="shrink-0 rounded bg-danger/10 px-1 text-[9px] leading-4 text-danger">
          {t('fleet.disconnected')}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-caption tabular-nums text-text-3">{group.rows.length}</span>
    </header>
  )
}

function FleetRow({
  row,
  batchResult,
  duration,
  compact,
  onJump,
  onResumed,
}: {
  row: FleetRowData
  batchResult?: BatchResult
  duration: string
  compact: boolean
  onJump: (row: FleetRowData) => void
  onResumed: () => void
}) {
  const { t } = useTranslation()
  const tone = ROW_TONE[rowTone(row)]
  const paneLabel = row.tmuxPaneId || row.paneId
  // blocked 已经靠自己的红色徽标表达了「要处理」，这里只补「最近事件失败」这一类隐性失败
  const failedEvent = row.status !== 'blocked' && fleetRank(row) === FLEET_ATTENTION_MAX_RANK
  return (
    <div
      data-fleet-row={row.key}
      className={cn(
        'tmuxgo-list-row relative flex h-9 items-center gap-2 border-b border-[var(--line)]/60 pl-3.5 pr-3 last:border-b-0',
        tone.row,
        tone.hover,
      )}
    >
      {/* 绝对定位的状态色条不占 flex 宽度，右侧数字列才能跨行对齐 */}
      <span
        data-fleet-anchor={rowTone(row)}
        aria-hidden="true"
        className={cn('absolute inset-y-0 left-0 w-[2px]', tone.bar)}
      />
      <button
        type="button"
        onClick={() => onJump(row)}
        title={`${row.sessionName} · ${paneLabel}`}
        aria-label={`${t('fleet.jump')} ${row.sessionName} ${paneLabel}`}
        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1.3fr)_1.5rem_minmax(0,3.5rem)_minmax(0,1.4fr)] items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
      >
        <span className="min-w-0 truncate text-xs text-text-1" title={row.sessionName}>
          {row.sessionName}
        </span>
        <span className="shrink-0 text-right font-mono text-caption tabular-nums text-text-3" title={paneLabel}>
          {row.paneIndex === null ? '—' : row.paneIndex}
        </span>
        <span className="min-w-0 truncate font-mono text-caption text-text-2" title={row.agent || undefined}>
          {row.agent || '—'}
        </span>
        <span className="min-w-0 truncate font-mono text-caption text-accent-2" title={row.task || undefined}>
          {row.task || '—'}
        </span>
      </button>
      {failedEvent ? (
        // 状态还是 working/idle 但最近一次事件 failed：徽标不会显示 failed，用细环+title 补上这条语义
        <span title={t('fleet.eventFailed')} className="shrink-0 rounded-full ring-1 ring-danger/40">
          <AgentStatusBadge status={row.status} withLabel />
        </span>
      ) : (
        <AgentStatusBadge status={row.status} withLabel />
      )}
      <span className="w-10 shrink-0 text-right font-mono text-caption tabular-nums text-text-3">
        {duration || '—'}
      </span>
      {!compact && (
        <span
          className="hidden min-w-0 max-w-[10rem] shrink-0 truncate text-caption text-text-3 md:block"
          title={row.updatedAt || undefined}
        >
          {row.lastEvent || '—'}
        </span>
      )}
      {batchResult === 'ok' && (
        <span
          aria-label={t('fleet.batchResumeOk')}
          title={t('fleet.batchResumeOk')}
          className="shrink-0 text-caption text-accent-2"
        >
          ✓
        </span>
      )}
      {batchResult === 'error' && (
        <span
          aria-label={t('fleet.batchResumeFailed')}
          title={t('fleet.batchResumeFailed')}
          className="shrink-0 text-caption text-danger"
        >
          !
        </span>
      )}
      {row.recovery && <AgentRecoveryBadge hostId={row.hostId} candidates={[row.recovery]} onResumed={onResumed} />}
    </div>
  )
}

// 空态：机队本来没 agent（装 hook 引导）与筛选后为空是两种意思，文案分开是刻意的
//（见 FleetPanel empty/degraded 测试）。
// 加载态用骨架行（固定 4 行）而不是一个「…」：首屏就有行的轮廓，数据到达时不跳版
function FleetSkeleton() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-busy="true" aria-label={t('fleet.loading')} className="animate-pulse">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex h-9 items-center gap-2 border-b border-[var(--line)]/60 px-3">
          <span className="h-2.5 w-24 rounded-full bg-bg-2/80" />
          <span className="h-2.5 w-8 rounded-full bg-bg-2/60" />
          <span className="h-2.5 w-16 rounded-full bg-bg-2/60" />
          <span className="ml-auto h-4 w-14 rounded-full bg-bg-2/70" />
          <span className="h-2.5 w-6 rounded-full bg-bg-2/60" />
        </div>
      ))}
    </div>
  )
}

export function FleetPanel({ mode = 'panel', onClose }: { mode?: 'panel' | 'mobile'; onClose?: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const [needsAttention, setNeedsAttention] = useState(false)
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
  // 批量 resume：逐行结果留在行上（成功/失败/需手动），汇总进 toast。
  // 只打「当前可见且 resumable」的候选：看不见的行不能因为你点了按钮就动手，
  // 而 resumable=false 的（原 pane 已没、只支持激活 pane 恢复）必须人来选目标。
  const [batch, setBatch] = useState<{ running: boolean; results: Record<string, BatchResult> }>({
    running: false,
    results: {},
  })
  const resumableRows = useMemo(() => fleet.rows.filter((row) => row.recovery && row.recovery.resumable), [fleet.rows])
  const resumeAll = async () => {
    if (batch.running || !resumableRows.length) return
    const skipped = Object.fromEntries(
      fleet.rows.filter((row) => row.recovery && !row.recovery.resumable).map((row) => [row.key, 'skipped' as const]),
    )
    setBatch({ running: true, results: skipped })
    // allSettled 而不是 all：一个失败不能把其余的成功结果一起吞掉
    const settled = await Promise.allSettled(
      resumableRows.map((row) =>
        api.agentRecovery.resume(row.hostId, row.recovery!.id, {
          paneId: row.recovery!.paneId,
          agentSessionId: row.recovery!.agentSessionId || '',
        }),
      ),
    )
    const results: Record<string, BatchResult> = { ...skipped }
    let ok = 0
    let failed = 0
    settled.forEach((outcome, index) => {
      const key = resumableRows[index].key
      if (outcome.status === 'fulfilled') {
        results[key] = 'ok'
        ok += 1
      } else {
        results[key] = 'error'
        failed += 1
      }
    })
    setBatch({ running: false, results })
    // 成功的候选会在服务端转成 resumed，refetch 后行上的恢复入口自然消失；
    // 失败的行保持原样，行内 badge 还能重试
    refetchRecovery()
    pushToast({
      type: failed ? 'error' : 'success',
      message: t('fleet.batchResumeSummary', { ok, failed }),
    })
  }

  const jumpToPane = async (row: FleetRowData) => {
    const result = await navigateInboxRoute(
      { hostId: row.hostId, sessionName: row.sessionName, paneId: row.paneId },
      queryClient,
    )
    // 只上报失败：成功时界面上就是「选中了那个 pane」，再弹 toast 反而吵
    if (result !== 'pane' && result !== 'session') pushToast({ type: 'error', message: t('inbox.targetMissing') })
  }
  const toggleHost = (hostId: string) =>
    setHostFilter((prev) => (prev.includes(hostId) ? prev.filter((id) => id !== hostId) : [...prev, hostId]))

  const compact = mode === 'mobile'
  const body = (
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {/* 骨架只出现在冷启动：某台 host 的 sessions 请求 pending（离线 ssh/agent 要等超时）
          时其余 host 的行已能渲染，再盖一层骨架就是「隐藏了又没有」的闪动 */}
      {loading && fleet.total === 0 && <FleetSkeleton />}
      {!loading &&
        fleet.total === 0 &&
        // 机器上根本没有 agent → 安装引导；有 agent 只是被筛掉 → 提示放宽条件
        (fleet.available === 0 ? (
          <EmptyState icon={<FiCpu size={15} />} title={t('fleet.empty')} description={t('fleet.emptyHint')} />
        ) : (
          <EmptyState icon={<FiSearch size={15} />} title={t('fleet.noMatch')} description={t('fleet.noMatchHint')} />
        ))}
      {fleet.groups.map((group) => (
        <section key={group.hostId} aria-label={group.hostName}>
          <FleetGroupHeader group={group} />
          {group.rows.map((row) => (
            <FleetRow
              key={row.key}
              row={row}
              batchResult={batch.results[row.key]}
              duration={formatDuration(row.since)}
              compact={compact}
              onJump={jumpToPane}
              onResumed={refetchRecovery}
            />
          ))}
        </section>
      ))}
    </div>
  )
  const header = (
    <PanelHeader
      icon={<FiCpu size={13} />}
      title={t('fleet.title')}
      subtitle={compact ? undefined : t('fleet.subtitle', { count: fleet.total })}
      onClose={onClose}
      closeLabel={t('common.close')}
    />
  )
  const content = (
    <>
      {hosts.length > 1 && <FleetHostChips hosts={hosts} selected={hostFilter} onToggle={toggleHost} />}
      <FleetToolbar
        query={query}
        onQueryChange={setQuery}
        needsAttention={needsAttention}
        hasTaskOnly={hasTaskOnly}
        onToggleAttention={() => setNeedsAttention((value) => !value)}
        onToggleTask={() => setHasTaskOnly((value) => !value)}
        recoveryCount={fleet.withRecovery}
        resumableCount={resumableRows.length}
        resumeRunning={batch.running}
        onResumeAll={() => void resumeAll()}
        onRefresh={refetch}
      />
      {body}
    </>
  )
  if (mode === 'mobile') {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {header}
        {content}
      </div>
    )
  }
  return (
    <section className="tmuxgo-content-surface flex h-full min-h-0 w-full flex-col overflow-hidden">
      {header}
      {content}
    </section>
  )
}
