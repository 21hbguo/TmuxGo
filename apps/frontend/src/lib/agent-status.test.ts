import { describe, expect, it } from 'vitest'
import { getDominantAgentStatus, getVisibleAgentStatuses, mergeAgentPaneEvent, removeAgentPaneEvent, summarizeAgentByWindow, summarizeAgentStates } from './agent-status'

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
  it('allows an authoritative snapshot to replace cached metadata', () => {
    const panes = [{ id: 'local:%1', windowId: 'local:@1', index: 0, title: 'agent', active: true, size: { cols: 80, rows: 24 }, agent: 'codex', agentStatus: 'done' as const, revision: 8 }]
    expect(mergeAgentPaneEvent(panes, { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'working', phase: 'working', revision: 2 }, true)[0].agentStatus).toBe('working')
  })
  it('summarizes live agent panes', () => {
    expect(summarizeAgentStates([{ paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'done', revision: 2 }])).toEqual({ idle: 0, working: 0, blocked: 0, done: 1, unknown: 0, total: 1 })
  })
  it('rolls agent statuses up per window', () => {
    const rollups = summarizeAgentByWindow([
      { windowId: 'local:@1', agentStatus: 'blocked' as const },
      { windowId: 'local:@1', agentStatus: 'blocked' as const },
      { windowId: 'local:@2', agentStatus: 'done' as const },
      { windowId: 'local:@2' },
    ])
    expect(rollups).toEqual([
      { windowId: 'local:@1', summary: { idle: 0, working: 0, blocked: 2, done: 0, unknown: 0, total: 2 }, statuses: ['blocked'] },
      { windowId: 'local:@2', summary: { idle: 0, working: 0, blocked: 0, done: 1, unknown: 0, total: 1 }, statuses: ['done'] },
    ])
  })
  it('preserves display metadata when merging agent events', () => {
    const panes = [{ id: 'local:%1', windowId: 'local:@1', index: 0, title: 'agent', active: true, size: { cols: 80, rows: 24 }, agent: 'codex', agentStatus: 'working' as const, revision: 4 }]
    const merged = mergeAgentPaneEvent(panes, { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'blocked', phase: 'permission_required', revision: 5, display: { title: 'Refactor', stateLabel: 'Waiting for approval', tokens: 1200, seq: 3, updatedAt: '2026-08-08T00:00:00.000Z' } })
    expect(merged[0].display).toEqual({ title: 'Refactor', stateLabel: 'Waiting for approval', tokens: 1200, seq: 3, updatedAt: '2026-08-08T00:00:00.000Z' })
    expect(removeAgentPaneEvent(merged, 'local:%1')[0]).toEqual({ id: 'local:%1', windowId: 'local:@1', index: 0, title: 'agent', active: true, size: { cols: 80, rows: 24 } })
  })
  it('keeps terminal pane data when removing agent metadata', () => {
    const panes = [{ id: 'local:%1', windowId: 'local:@1', index: 0, title: 'codex', active: true, size: { cols: 80, rows: 24 }, agent: 'codex', agentSessionId: 'session-1', agentStatus: 'working' as const, phase: 'working' as const, source: 'process' as const, confidence: 'medium' as const, revision: 4 }]
    expect(removeAgentPaneEvent(panes, 'local:%1')[0]).toEqual({ id: 'local:%1', windowId: 'local:@1', index: 0, title: 'codex', active: true, size: { cols: 80, rows: 24 } })
  })
})
