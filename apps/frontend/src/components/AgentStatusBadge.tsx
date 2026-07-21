'use client'
import type { AgentStatus, AgentSummary } from '@/types'
import { getDominantAgentStatus } from '@/lib/agent-status'
import { useTranslation } from '@/i18n'

const tone: Record<AgentStatus, string> = {
  idle: 'border-text-1/10 bg-bg-2/55 text-text-3',
  working: 'border-accent/25 bg-accent/10 text-accent',
  blocked: 'border-danger/35 bg-danger/10 text-danger',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  unknown: 'border-text-1/10 bg-bg-2/55 text-text-3',
}
const dot: Record<AgentStatus, string> = {
  idle: 'bg-text-3',
  working: 'bg-accent animate-pulse',
  blocked: 'bg-danger',
  done: 'bg-emerald-400',
  unknown: 'bg-text-3/50',
}
export function AgentStatusBadge({ status, summary, compact = false }: { status?: AgentStatus | null; summary?: AgentSummary | null; compact?: boolean }) {
  const { t } = useTranslation()
  const resolved = status || getDominantAgentStatus(summary)
  if (!resolved) return null
  const count = summary ? summary[resolved] : 0
  const label = t(`agent.status.${resolved}`)
  return <span title={label} className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border ${compact ? 'w-5 justify-center px-0' : 'px-2'} text-[10px] font-medium ${tone[resolved]}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[resolved]}`} />{!compact && <span>{count > 1 ? `${count} ` : ''}{label}</span>}</span>
}
