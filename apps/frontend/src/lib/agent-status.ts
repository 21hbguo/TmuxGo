import type { AgentPaneState, AgentStatus, AgentSummary, Pane } from '@/types'

const statusPriority: AgentStatus[] = ['blocked', 'done', 'working', 'idle', 'unknown']
const statusDisplayOrder: AgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown']
export function getDominantAgentStatus(summary?: AgentSummary | null) {
  if (!summary?.total) return null
  return statusPriority.find((status) => summary[status] > 0) || null
}
export function getVisibleAgentStatuses(summary?: AgentSummary | null) {
  return summary?.total ? statusDisplayOrder.filter((status) => summary[status] > 0) : []
}
export function summarizeAgentStates(states: AgentPaneState[]): AgentSummary {
  return states.reduce((summary, state) => {
    summary[state.agentStatus] += 1
    summary.total += 1
    return summary
  }, { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 })
}
export function mergeAgentPaneEvent(panes: Pane[], incoming: AgentPaneState, force = false) {
  return panes.map((pane) => pane.id !== incoming.paneId || !force && (pane.revision || 0) > incoming.revision ? pane : { ...pane, agent: incoming.agent, agentSessionId: incoming.agentSessionId, agentStatus: incoming.agentStatus, phase: incoming.phase, lastEvent: incoming.lastEvent, source: incoming.source, confidence: incoming.confidence, since: incoming.since, updatedAt: incoming.updatedAt, eventId: incoming.eventId, message: incoming.message, revision: incoming.revision })
}
export function removeAgentPaneEvent(panes: Pane[], paneId: string) {
  return panes.map((pane) => {
    if (pane.id !== paneId) return pane
    const { agent, agentSessionId, agentStatus, phase, lastEvent, source, confidence, since, updatedAt, eventId, message, revision, ...terminalPane } = pane
    return terminalPane
  })
}
