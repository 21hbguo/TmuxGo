'use client'
import { Fragment } from 'react'
import { FiX } from 'react-icons/fi'
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
// onClearDone：done 徽标上的「标记已查看」入口。done 即 unseen，清除只针对 done——
// working/blocked 不提供该操作，避免误清仍需处理的状态
export function AgentStatusBadge({
  status,
  summary,
  compact = false,
  onStatusClick,
  onClearDone,
}: {
  status?: AgentStatus | null
  summary?: AgentSummary | null
  compact?: boolean
  onStatusClick?: (status: AgentStatus) => void
  onClearDone?: () => void
}) {
  const { t } = useTranslation()
  const clearTitle = t('agent.markSeen')
  const clearDoneButton = onClearDone ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClearDone()
      }}
      title={clearTitle}
      aria-label={clearTitle}
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-accent-2 hover:bg-accent-2/25"
    >
      <FiX aria-hidden="true" className="h-3 w-3" />
    </button>
  ) : null
  if (summary && !compact) {
    const statuses = getVisibleAgentStatuses(summary)
    if (!statuses.length) return null
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {statuses.map((item) => (
          <Fragment key={item}>
            <button
              type="button"
              onClick={() => onStatusClick?.(item)}
              title={t(`agent.status.${item}`)}
              className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-caption font-medium transition-opacity hover:opacity-80 ${tone[item]}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[item]}`} />
              <span>
                {summary[item]} {t(`agent.status.${item}`)}
              </span>
            </button>
            {item === 'done' ? clearDoneButton : null}
          </Fragment>
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
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border ${compact && !(resolved === 'done' && clearDoneButton) ? 'w-5 justify-center px-0' : 'px-2'} text-caption font-medium ${tone[resolved]}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[resolved]}`} />
      {!compact && (
        <span>
          {count > 1 ? `${count} ` : ''}
          {label}
        </span>
      )}
      {resolved === 'done' ? clearDoneButton : null}
    </span>
  )
}
