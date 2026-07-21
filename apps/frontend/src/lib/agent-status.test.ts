import { describe, expect, it } from 'vitest'
import { getDominantAgentStatus, getVisibleAgentStatuses, mergeAgentPaneEvent, summarizeAgentStates } from './agent-status'

describe('agent status', () => {
  it('uses attention priority for session summaries', () => {
    const summary = { idle: 2, working: 2, blocked: 1, done: 1, unknown: 0, total: 6 }
    expect(getDominantAgentStatus(summary)).toBe('blocked')
    expect(getVisibleAgentStatuses(summary)).toEqual(['idle', 'working', 'blocked', 'done'])
  })
  it('ignores stale pane revisions', () => {
    const panes = [{ id: 'local:%1', windowId: 'local:@1', index: 0, title: 'agent', active: true, size: { cols: 80, rows: 24 }, agent: 'codex', agentStatus: 'working' as const, revision: 4 }]
    expect(mergeAgentPaneEvent(panes, { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'idle', revision: 3 })[0].agentStatus).toBe('working')
  })
  it('summarizes live agent panes', () => {
    expect(summarizeAgentStates([{ paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'done', revision: 2 }])).toEqual({ idle: 0, working: 0, blocked: 0, done: 1, unknown: 0, total: 1 })
  })
})
