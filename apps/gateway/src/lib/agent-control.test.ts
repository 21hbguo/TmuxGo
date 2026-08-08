import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentControl, AgentWaitError, resolveAgentWaitTarget } from './agent-control.js'
import type { AgentPaneState } from './agent-state.js'
import type { AgentMonitorEvent } from './agent-monitor.js'

function pane(paneId: string, overrides: Partial<AgentPaneState> = {}): AgentPaneState {
  return { paneId, tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1), sessionName: 'dev', agent: 'codex', agentSessionId: paneId + ':dev', agentStatus: 'working', phase: 'working', lastEvent: 'started', source: 'process', confidence: 'medium', since: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:01.000Z', eventId: paneId + ':started', revision: 1, ...overrides }
}
function stateWith(panes: AgentPaneState[]) {
  return { states: panes, emit: [] as AgentMonitorEvent[] }
}
function createControl(initial: AgentPaneState[]) {
  const holder = stateWith(initial)
  let listeners = new Set<(event: AgentMonitorEvent) => void>()
  const control = new AgentControl({
    now: () => 1000,
    getStates: () => holder.states,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    scanStates: async () => holder.states,
  })
  const emit = (event: AgentMonitorEvent) => { for (const listener of listeners) listener(event) }
  return { control, holder, emit }
}
test('resolves immediately when the condition is already met', async () => {
  const { control } = createControl([pane('local:%1', { agentStatus: 'blocked', phase: 'permission_required' })])
  const result = await control.wait({ paneId: 'local:%1' }, { status: 'blocked' })
  assert.equal(result.pane.agentStatus, 'blocked')
  assert.equal(result.elapsedMs, 0)
})
test('resolves on a later status event matching the condition', async () => {
  const { control, emit } = createControl([pane('local:%1')])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'blocked' })
  emit({ type: 'agent_status_changed', initial: false, hostId: 'local', sessionName: 'dev', pane: pane('local:%1', { agentStatus: 'blocked', phase: 'permission_required', lastEvent: 'permission_required', eventId: 'e1', revision: 2 }), eventId: 'e1' })
  const result = await promise
  assert.equal(result.pane.agentStatus, 'blocked')
  assert.equal(result.elapsedMs, 0)
})
test('rejects with OCCUPANT_CHANGED when the pinned occupant is replaced', async () => {
  const { control, emit } = createControl([pane('local:%1', { agent: 'codex', agentSessionId: 'local:%1:dev' })])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'blocked' })
  emit({ type: 'agent_status_changed', initial: false, hostId: 'local', sessionName: 'dev', pane: pane('local:%1', { agent: 'claude', agentSessionId: 'local:%1:other', agentStatus: 'blocked', phase: 'permission_required', lastEvent: 'permission_required', eventId: 'e2', revision: 2 }), eventId: 'e2' })
  await assert.rejects(promise, (error: AgentWaitError) => error.code === 'OCCUPANT_CHANGED')
})
test('rejects with PANE_REMOVED when the target pane disappears', async () => {
  const { control, emit } = createControl([pane('local:%1')])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'blocked' })
  emit({ type: 'agent_status_removed', initial: false, hostId: 'local', paneId: 'local:%1', sessionName: 'dev', reason: 'pane_exited', eventId: 'r1' })
  await assert.rejects(promise, (error: AgentWaitError) => error.code === 'PANE_REMOVED')
})
test('rejects with TIMEOUT when the condition is never met', async () => {
  const { control } = createControl([pane('local:%1')])
  await assert.rejects(control.wait({ paneId: 'local:%1' }, { status: 'blocked' }, { timeoutMs: 250, now: () => Date.now() }), (error: AgentWaitError) => error.code === 'TIMEOUT')
})
test('waits by sessionName and agent and rejects when occupied by another agent', async () => {
  const { control, emit } = createControl([pane('local:%1', { agent: 'opencode' })])
  const promise = control.wait({ sessionName: 'dev', agent: 'codex' }, { status: 'blocked' })
  emit({ type: 'agent_status_changed', initial: false, hostId: 'local', sessionName: 'dev', pane: pane('local:%1', { agent: 'opencode', agentStatus: 'blocked', phase: 'permission_required', lastEvent: 'permission_required', eventId: 'e3', revision: 2 }), eventId: 'e3' })
  await assert.rejects(promise, (error: AgentWaitError) => error.code === 'OCCUPANT_CHANGED')
})
test('rejects invalid targets and empty conditions', async () => {
  const { control } = createControl([])
  await assert.rejects(control.wait({ paneId: 'bad' } as never, { status: 'blocked' }), (error: AgentWaitError) => error.code === 'INVALID_TARGET')
  await assert.rejects(control.wait({ paneId: 'local:%1' }, {}), (error: AgentWaitError) => error.code === 'INVALID_TARGET')
  assert.throws(() => resolveAgentWaitTarget({ sessionName: '', agent: '' }), (error: AgentWaitError) => error.code === 'INVALID_TARGET')
})
test('tracks active wait count and cleans up after resolution', async () => {
  const { control, emit } = createControl([pane('local:%1')])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'done' })
  assert.equal(control.activeWaitCount(), 1)
  emit({ type: 'agent_status_changed', initial: false, hostId: 'local', sessionName: 'dev', pane: pane('local:%1', { agentStatus: 'done', phase: 'idle', lastEvent: 'completed', eventId: 'e4', revision: 2 }), eventId: 'e4' })
  await promise
  assert.equal(control.activeWaitCount(), 0)
})
