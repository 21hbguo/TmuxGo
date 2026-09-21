import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ingestAgentEvent, normalizeAgentEvent } from './agent-events.js'

test('normalizes Claude hook lifecycle events and redacts message paths', () => {
  const event = normalizeAgentEvent(
    { hook_event_name: 'PermissionRequest', session_id: 'claude-session', message: 'Allow /home/guo/private/config?' },
    { hostId: 'local', provider: 'claude-code', sessionName: 'dev', tmuxPaneId: '%1' },
  )
  assert.equal(event?.agent, 'claude')
  assert.equal(event?.phase, 'permission_required')
  assert.equal(event?.source, 'hook')
  assert.equal(event?.message?.includes('/home/guo/private'), false)
  assert.equal(event?.message?.includes('[path]'), true)
})
test('normalizes Claude Notification title, elicitation, and subagent per official docs', () => {
  const notification = normalizeAgentEvent(
    {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      title: 'Approve bash',
      message: 'approval needed',
    },
    { hostId: 'local', provider: 'claude', sessionName: 'dev', tmuxPaneId: '%1' },
  )
  const elicitation = normalizeAgentEvent(
    { hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'form' },
    { hostId: 'local', provider: 'claude', sessionName: 'dev', tmuxPaneId: '%1' },
  )
  const subagentStop = normalizeAgentEvent(
    { hook_event_name: 'SubagentStop', agent_id: 'sub-1' },
    { hostId: 'local', provider: 'claude', sessionName: 'dev', tmuxPaneId: '%1' },
  )
  assert.equal(notification?.phase, 'permission_required')
  assert.equal(notification?.display?.title, 'Approve bash')
  assert.equal(elicitation?.phase, 'needs_input')
  assert.equal(subagentStop?.phase, 'working')
})
test('normalizes Codex approval and completion statuses', () => {
  const approval = normalizeAgentEvent(
    {
      type: 'thread/status/changed',
      status: { type: 'waitingOnApproval' },
      threadId: 'thread-1',
      eventId: 'approval-1',
    },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  const completed = normalizeAgentEvent(
    { type: 'item/completed', threadId: 'thread-1', eventId: 'complete-1' },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  assert.equal(approval?.phase, 'permission_required')
  assert.equal(approval?.agentSessionId, 'thread-1')
  assert.equal(completed?.lastEvent, 'completed')
  assert.equal(completed?.phase, 'idle')
})
test('normalizes Codex official wire format with activeFlags and camelCase status', () => {
  const approval = normalizeAgentEvent(
    {
      type: 'thread/status/changed',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      threadId: 'thread-1',
      eventId: 'approval-2',
    },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  const input = normalizeAgentEvent(
    {
      type: 'thread/status/changed',
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      threadId: 'thread-1',
      eventId: 'input-2',
    },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  const systemError = normalizeAgentEvent(
    { type: 'thread/status/changed', status: { type: 'systemError' }, threadId: 'thread-1', eventId: 'error-2' },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  const closed = normalizeAgentEvent(
    { method: 'thread/closed', threadId: 'thread-1', eventId: 'closed-2' },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  const autoApproval = normalizeAgentEvent(
    { type: 'item/autoApprovalReview/started', threadId: 'thread-1', eventId: 'auto-2' },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  assert.equal(approval?.phase, 'permission_required')
  assert.equal(input?.phase, 'needs_input')
  assert.equal(systemError?.phase, 'failed')
  assert.equal(closed?.phase, 'ended')
  assert.equal(autoApproval?.phase, 'working')
})
test('normalizes OpenCode retry fields and keeps event ids stable', () => {
  const input = {
    status: 'retry',
    attempt: 3,
    message: 'retrying /tmp/work',
    action: 'continue',
    next: 'backoff',
    eventId: 'retry-1',
  }
  const first = normalizeAgentEvent(input, {
    hostId: 'local',
    provider: 'opencode',
    agentSessionId: 'session-1',
    sessionName: 'dev',
  })
  const second = normalizeAgentEvent(input, {
    hostId: 'local',
    provider: 'opencode',
    agentSessionId: 'session-1',
    sessionName: 'dev',
  })
  assert.equal(first?.phase, 'retrying')
  assert.equal(first?.attempt, 3)
  assert.equal(first?.message?.includes('/tmp/work'), false)
  assert.equal(first?.eventId, second?.eventId)
  assert.equal(
    ingestAgentEvent(input, { hostId: 'local', provider: 'opencode', agentSessionId: 'session-1', sessionName: 'dev' })
      ?.eventId,
    first?.eventId,
  )
})
test('surfaces Reasonix answer text as display metadata', () => {
  const ctx = { hostId: 'local', provider: 'reasonix', agentSessionId: 'session-1', sessionName: 'dev' }
  const stop = normalizeAgentEvent({ event: 'Stop', cwd: '/repo', lastAssistantText: '已修复测试', turn: 1 }, ctx)
  const subagent = normalizeAgentEvent({ event: 'SubagentStop', cwd: '/repo', lastAssistantText: '子代理结论' }, ctx)
  assert.equal(stop?.phase, 'idle')
  assert.equal(stop?.display?.title, '已修复测试')
  assert.equal(stop?.display?.ttlMs, 60000)
  assert.equal(subagent?.phase, 'working')
  assert.equal(subagent?.display?.title, '子代理结论')
})
test('surfaces Claude answer and subagent text as display metadata', () => {
  const stop = normalizeAgentEvent(
    { hook_event_name: 'Stop', last_assistant_message: 'Fixed the parser' },
    { hostId: 'local', provider: 'claude', sessionName: 'dev', tmuxPaneId: '%1' },
  )
  const subagent = normalizeAgentEvent(
    { hook_event_name: 'SubagentStop', agent_id: 'sub-1', last_assistant_message: 'sub result' },
    { hostId: 'local', provider: 'claude', sessionName: 'dev', tmuxPaneId: '%1' },
  )
  assert.equal(stop?.phase, 'idle')
  assert.equal(stop?.display?.title, 'Fixed the parser')
  assert.equal(subagent?.phase, 'working')
  assert.equal(subagent?.display?.title, 'sub result')
})
test('surfaces OpenCode answer text as display metadata', () => {
  const ctx = { hostId: 'local', provider: 'opencode', agentSessionId: 'session-1', sessionName: 'dev' }
  const text = normalizeAgentEvent({ type: 'session.next.text.ended', text: 'done the thing' }, ctx)
  const reasoning = normalizeAgentEvent({ type: 'session.next.reasoning.ended', text: 'because of x' }, ctx)
  assert.equal(text?.phase, 'working')
  assert.equal(text?.display?.title, 'done the thing')
  assert.equal(reasoning?.phase, 'working')
  assert.equal(reasoning?.display?.title, 'because of x')
})
test('normalizes OpenCode session errors as failed', () => {
  const sessionError = normalizeAgentEvent(
    { type: 'session.error', error: { name: 'ProviderAuthError' }, eventId: 'err-1' },
    { hostId: 'local', provider: 'opencode', agentSessionId: 'session-1', sessionName: 'dev' },
  )
  const stepFailed = normalizeAgentEvent(
    { type: 'session.next.step.failed', error: { name: 'UnknownError' }, eventId: 'err-2' },
    { hostId: 'local', provider: 'opencode', agentSessionId: 'session-1', sessionName: 'dev' },
  )
  assert.equal(sessionError?.phase, 'failed')
  assert.equal(stepFailed?.phase, 'failed')
})
test('normalizes display metadata patches with tokens, seq, and ttl', () => {
  const event = normalizeAgentEvent(
    {
      type: 'item/started',
      threadId: 'thread-1',
      eventId: 'd1',
      display: { title: 'Refactor parser', state_label: 'Working · 2/5', tokens: 1240, seq: 3, ttl_ms: 45000 },
    },
    { hostId: 'local', provider: 'codex', tmuxPaneId: '%2', sessionName: 'dev' },
  )
  assert.equal(event?.display?.title, 'Refactor parser')
  assert.equal(event?.display?.stateLabel, 'Working · 2/5')
  assert.equal(event?.display?.tokens, 1240)
  assert.equal(event?.display?.seq, 3)
  assert.equal(event?.display?.ttlMs, 45000)
  const flat = normalizeAgentEvent(
    { type: 'working', displayTitle: 'Parallel tasks', tokens: '800' },
    { hostId: 'local', provider: 'gemini', agentSessionId: 'session-1', sessionName: 'dev' },
  )
  assert.equal(flat?.display?.title, 'Parallel tasks')
  assert.equal(flat?.display?.tokens, 800)
})
test('normalizes Reasonix hook lifecycle events per official docs', () => {
  const ctx = { hostId: 'local', provider: 'reasonix', agentSessionId: 'session-1', sessionName: 'dev' }
  const sessionStart = normalizeAgentEvent({ event: 'SessionStart', cwd: '/repo' }, ctx)
  const stop = normalizeAgentEvent({ event: 'Stop', cwd: '/repo', lastAssistantText: 'done' }, ctx)
  const sessionEnd = normalizeAgentEvent({ event: 'SessionEnd', cwd: '/repo' }, ctx)
  const subagentStop = normalizeAgentEvent({ event: 'SubagentStop', cwd: '/repo', lastAssistantText: '结论' }, ctx)
  const approval = normalizeAgentEvent(
    { event: 'Notification', cwd: '/repo', message: 'approval needed: bash go test ./...' },
    ctx,
  )
  const question = normalizeAgentEvent({ event: 'Notification', cwd: '/repo', message: 'type your answer' }, ctx)
  assert.equal(sessionStart?.phase, 'working')
  assert.equal(sessionStart?.lastEvent, 'started')
  assert.equal(sessionStart?.type, 'session_started')
  assert.equal(stop?.phase, 'idle')
  assert.equal(stop?.lastEvent, 'completed')
  assert.equal(sessionEnd?.phase, 'ended')
  assert.equal(sessionEnd?.type, 'session_ended')
  assert.equal(subagentStop?.phase, 'working')
  assert.equal(approval?.phase, 'permission_required')
  assert.equal(approval?.message?.includes('/...'), false)
  assert.equal(question?.phase, 'needs_input')
})
test('normalizes Reasonix tool activity events as working', () => {
  const ctx = { hostId: 'local', provider: 'reasonix', agentSessionId: 'session-1', sessionName: 'dev' }
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostLLMCall', 'PreCompact']) {
    const normalized = normalizeAgentEvent({ event, cwd: '/repo' }, ctx)
    assert.equal(normalized?.phase, 'working', event)
    assert.equal(normalized?.source, 'hook', event)
  }
})
test('requires a pane, session, or native session binding', () => {
  assert.equal(normalizeAgentEvent({ type: 'busy' }, { hostId: 'local', provider: 'opencode' }), null)
})
