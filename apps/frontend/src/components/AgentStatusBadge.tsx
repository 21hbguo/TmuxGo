'use client'
import type { AgentStatus, AgentSummary } from '@/types'
import { getDominantAgentStatus, getVisibleAgentStatuses } from '@/lib/agent-status'
import { useTranslation } from '@/i18n'

const tone: Record<AgentStatus, string> = {
  idle: 'border-text-1/10 bg-bg-2/55 text-text-3',
  working: 'border-accent/25 bg-accent/10 text-accent',
  blocked: 'border-danger/35 bg-danger/10 text-danger',
  done: 'border-accent-2/30 bg-accent-2/10 text-accent-2',
  unknown: 'border-text-1/10 bg-bg-2/55 text-text-3',
}
const dot: Record<AgentStatus, string> = {
  idle: 'bg-text-3',
  working: 'bg-accent animate-pulse',
  blocked: 'bg-danger',
  done: 'bg-accent-2',
  unknown: 'bg-text-3/50',
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
            className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-caption font-medium transition-opacity hover:opacity-80 ${tone[item]}`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[item]}`} />
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
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border ${compact ? 'w-5 justify-center px-0' : withLabel ? 'px-1.5' : 'px-2'} text-caption font-medium tabular-nums transition-colors ${tone[resolved]}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[resolved]}`} />
      {!compact && count > 0 && <span>{count}</span>}
      {!compact && withLabel && count === 0 && <span className="whitespace-nowrap">{label}</span>}
    </span>
  )
}
