import type { AgentPaneState, AgentStatus, AgentSummary, Pane } from '@/types'

const statusPriority: AgentStatus[] = ['blocked', 'done', 'working', 'idle', 'unknown']
export function getDominantAgentStatus(summary?: AgentSummary | null) {
  if (!summary?.total) return null
  return statusPriority.find((status) => summary[status] > 0) || null
}
export function summarizeAgentStates(states: AgentPaneState[]): AgentSummary {
  return states.reduce((summary, state) => {
    summary[state.agentStatus] += 1
    summary.total += 1
    return summary
  }, { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 })
}
export function mergeAgentPaneEvent(panes: Pane[], incoming: AgentPaneState) {
  return panes.map((pane) => pane.id !== incoming.paneId || (pane.revision || 0) > incoming.revision ? pane : { ...pane, agent: incoming.agent, agentStatus: incoming.agentStatus, revision: incoming.revision })
}
