'use client'
import type { AgentStatus, AgentSummary } from '@/types'
import { getDominantAgentStatus, getVisibleAgentStatuses } from '@/lib/agent-status'
import { useTranslation } from '@/i18n'
import { StatusDot, type StatusTone } from './StatusDot'

// 业务枚举 → 语义 tone 只在这里映射；surface 配色仍由本组件的 TONE_SURFACE 决定（badge 是独立组件，不做通用化）
const TONE: Record<AgentStatus, StatusTone> = {
  idle: 'muted',
  working: 'accent',
  blocked: 'danger',
  done: 'success',
  unknown: 'muted',
}
const TONE_SURFACE: Record<AgentStatus, string> = {
  idle: 'border-text-1/10 bg-bg-2/55 text-text-3',
  working: 'border-accent/25 bg-accent/10 text-accent',
  blocked: 'border-danger/35 bg-danger/10 text-danger',
  done: 'border-accent-2/30 bg-accent-2/10 text-accent-2',
  unknown: 'border-text-1/10 bg-bg-2/55 text-text-3',
}
// unknown 的圆点比 idle 更淡（原实现 bg-text-3/50），用透明度表达“未知”而非新增 tone
const DOT_EXTRA: Partial<Record<AgentStatus, string>> = { unknown: 'opacity-50' }

function Dot({ status }: { status: AgentStatus }) {
  return <StatusDot tone={TONE[status]} pulse={status === 'working'} className={DOT_EXTRA[status]} />
}

export function AgentStatusBadge({
  status,
  summary,
  compact = false,
  withLabel = false,
  onStatusClick,
}: {
  status?: AgentStatus | null
  summary?: AgentSummary | null
  compact?: boolean
  /** 单状态且需要让颜色之外也有语义时打开（fleet 行用）：徽标右侧补一行状态文案 */
  withLabel?: boolean
  onStatusClick?: (status: AgentStatus) => void
}) {
  const { t } = useTranslation()
  if (summary && !compact) {
    const statuses = getVisibleAgentStatuses(summary)
    if (!statuses.length) return null
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {statuses.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onStatusClick?.(item)}
            title={t(`agent.status.${item}`)}
            aria-label={t(`agent.status.${item}`)}
            className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-caption font-medium transition-opacity hover:opacity-80 ${TONE_SURFACE[item]}`}
          >
            <Dot status={item} />
            <span>{summary[item]}</span>
          </button>
        ))}
      </span>
    )
  }
  const resolved = status || getDominantAgentStatus(summary)
  if (!resolved) return null
  const count = summary ? summary[resolved] : 0
  const label = t(`agent.status.${resolved}`)
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border ${compact ? 'w-5 justify-center px-0' : withLabel ? 'px-1.5' : 'px-2'} text-caption font-medium tabular-nums transition-colors ${TONE_SURFACE[resolved]}`}
    >
      <Dot status={resolved} />
      {!compact && count > 0 && <span>{count}</span>}
      {!compact && withLabel && count === 0 && <span className="whitespace-nowrap">{label}</span>}
    </span>
  )
}
