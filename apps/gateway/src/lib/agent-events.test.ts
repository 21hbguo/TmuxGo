import assert from 'node:assert/strict'
import test from 'node:test'
import { ingestAgentEvent, normalizeAgentEvent } from './agent-events.js'

test('normalizes Claude hook lifecycle events and redacts message paths', () => {
  const event = normalizeAgentEvent({ hook_event_name: 'PermissionRequest', session_id: 'claude-session', message: 'Allow /home/guo/private/config?' }, { hostId: 'local', provider: 'claude-code', sessionName: 'dev', tmuxPaneId: '%1' })
  assert.equal(event?.agent, 'claude')
  assert.equal(event?.phase, 'permission_required')
  assert.equal(event?.source, 'hook')
  assert.equal(event?.message?.includes('/home/guo/private'), false)
  assert.equal(event?.message?.includes('[path]'), true)
})
test('normalizes Codex approval and completion statuses', () => {
  const approval = normalizeAgentEvent({ type: 'thread/status/changed', status: { type: 'waitingOnApproval' }, threadId: 'thread-1', eventId: 'approval-1' }, { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' })
  const completed = normalizeAgentEvent({ type: 'item/completed', threadId: 'thread-1', eventId: 'complete-1' }, { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' })
  assert.equal(approval?.phase, 'permission_required')
  assert.equal(approval?.agentSessionId, 'thread-1')
  assert.equal(completed?.lastEvent, 'completed')
  assert.equal(completed?.phase, 'idle')
})
test('normalizes OpenCode retry fields and keeps event ids stable', () => {
  const input = { status: 'retry', attempt: 3, message: 'retrying /tmp/work', action: 'continue', next: 'backoff', eventId: 'retry-1' }
  const first = normalizeAgentEvent(input, { hostId: 'local', provider: 'opencode', agentSessionId: 'session-1', sessionName: 'dev' })
  const second = normalizeAgentEvent(input, { hostId: 'local', provider: 'opencode', agentSessionId: 'session-1', sessionName: 'dev' })
  assert.equal(first?.phase, 'retrying')
  assert.equal(first?.attempt, 3)
  assert.equal(first?.message?.includes('/tmp/work'), false)
  assert.equal(first?.eventId, second?.eventId)
  assert.equal(ingestAgentEvent(input, { hostId: 'local', provider: 'opencode', agentSessionId: 'session-1', sessionName: 'dev' })?.eventId, first?.eventId)
})
test('requires a pane, session, or native session binding', () => {
  assert.equal(normalizeAgentEvent({ type: 'busy' }, { hostId: 'local', provider: 'opencode' }), null)
})
