import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentFeed, AgentFeedError, type AgentFeedFrame, type AgentFeedOutbound } from './agent-stream.js'
import type { AgentMonitorEvent } from './agent-monitor.js'
import type { AgentPaneState } from './agent-state.js'
import type { AccessScope } from './access-scope.js'

function pane(
  paneId: string,
  sessionName = 'dev',
  stateSeq = 1,
  agentStatus: AgentPaneState['agentStatus'] = 'working',
): AgentPaneState {
  return {
    paneId,
    tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1),
    sessionName,
    agent: 'codex',
    agentSessionId: paneId + ':session',
    agentStatus,
    phase: agentStatus === 'working' ? 'working' : 'idle',
    lastEvent: agentStatus === 'working' ? 'started' : 'completed',
    source: 'protocol',
    confidence: 'high',
    since: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:01.000Z',
    eventId: paneId + ':event',
    revision: stateSeq,
    stateSeq,
  }
}
const changed = (hostId: string, value: AgentPaneState): AgentMonitorEvent => ({
  type: 'agent_status_changed',
  initial: false,
  hostId,
  sessionName: value.sessionName,
  pane: value,
  eventId: value.eventId!,
})
const removed = (hostId: string, value: AgentPaneState, reason = 'pane_exited'): AgentMonitorEvent => ({
  type: 'agent_status_removed',
  initial: false,
  hostId,
  paneId: value.paneId,
  sessionName: value.sessionName,
  reason,
  eventId: value.paneId + ':removed',
})
const snapshot = (hostId: string, agents: AgentPaneState[]): AgentMonitorEvent => ({
  type: 'agent_status_snapshot',
  initial: true,
  hostId,
  revision: 1,
  agents,
  eventId: hostId + ':snapshot:1',
})
const notification = (hostId: string, value: AgentPaneState): AgentMonitorEvent => ({
  type: 'agent_notification',
  initial: false,
  hostId,
  sessionName: value.sessionName,
  pane: value,
  eventId: value.paneId + ':notify',
})
// 合并窗内的 flush 是 setTimeout：测试按小窗口 + 轮询等待，避免依赖真实时钟精度
async function until(predicate: () => boolean, timeoutMs = 200) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createFeed(
  options: {
    states?: Record<string, AgentPaneState[]>
    scope?: AccessScope
    shareTicket?: boolean
    frameMs?: number
    congested?: () => boolean
  } = {},
) {
  const frames: AgentFeedOutbound[] = []
  const states = options.states || {}
  const feed = new AgentFeed({
    send: (frame) => frames.push(frame),
    getStates: (hostId) => states[hostId] || null,
    getRevision: () => 7,
    isCongested: options.congested,
    scope: options.scope,
    shareTicket: options.shareTicket,
    frameMs: options.frameMs ?? 0,
  })
  const stateFrames = () => frames.filter((frame): frame is AgentFeedFrame => frame.type === 'agent_state')
  return { feed, frames, states, stateFrames }
}

test('subscribe sends a full frame first with seq 1 and host revision', () => {
  const { feed, stateFrames } = createFeed({ frameMs: 0, states: { local: [pane('local:%1', 'dev', 4)] } })
  const result = feed.subscribe({ hostId: 'local' })
  assert.equal(result.seq, 1)
  const [frame] = stateFrames()
  assert.equal(frame.mode, 'full')
  assert.equal(frame.seq, 1)
  assert.equal(frame.subId, result.subId)
  assert.equal(frame.revision, 7)
  assert.equal(frame.stateSeq, 4)
  assert.deepEqual(
    frame.changed.map((item) => item.paneId),
    ['local:%1'],
  )
})

test('subscribe narrows sessions by scope without telling the caller which names exist', () => {
  const scope: AccessScope = { hosts: ['local'], sessions: ['dev'] }
  const { feed, stateFrames } = createFeed({
    frameMs: 0,
    scope,
    states: { local: [pane('local:%1', 'dev', 3), pane('local:%2', 'secret', 4)] },
  })
  feed.subscribe({ hostId: 'local', sessions: ['dev', 'secret'] })
  assert.deepEqual(
    stateFrames()[0].changed.map((item) => item.paneId),
    ['local:%1'],
  )
})

test('denies out-of-scope host and every share ticket subscriber', () => {
  const scope: AccessScope = { hosts: ['local'] }
  const outOfScope = createFeed({ frameMs: 0, scope })
  assert.throws(
    () => outOfScope.feed.subscribe({ hostId: 'remote' }),
    (error: unknown) => error instanceof AgentFeedError && error.code === 'AGENT_SCOPE_DENIED',
  )
  assert.equal(outOfScope.stateFrames().length, 0)
  const share = createFeed({ frameMs: 0, shareTicket: true })
  assert.throws(
    () => share.feed.subscribe({ hostId: 'local' }),
    (error: unknown) => error instanceof AgentFeedError && error.code === 'AGENT_SCOPE_DENIED',
  )
  assert.equal(share.frames.length, 0)
})

test('rejects unknown protocol versions and the ninth subscription', () => {
  const { feed } = createFeed({ frameMs: 0 })
  assert.throws(
    () => feed.subscribe({ hostId: 'local', agentProtoVersion: 2 }),
    (error: unknown) => error instanceof AgentFeedError && error.code === 'AGENT_PROTO_VERSION_UNSUPPORTED',
  )
  for (let index = 0; index < 8; index += 1) feed.subscribe({ hostId: 'local' })
  assert.throws(
    () => feed.subscribe({ hostId: 'local' }),
    (error: unknown) => error instanceof AgentFeedError && error.code === 'AGENT_SUB_LIMIT',
  )
})

test('coalesces changes per pane within the window and keeps the newest stateSeq', async () => {
  const { feed, stateFrames } = createFeed({ frameMs: 5 })
  feed.subscribe({ hostId: 'local' })
  feed.ingest(changed('local', pane('local:%1', 'dev', 5)))
  feed.ingest(changed('local', pane('local:%1', 'dev', 6)))
  feed.ingest(changed('local', pane('local:%1', 'dev', 5)))
  feed.ingest(changed('local', pane('local:%2', 'dev', 7)))
  await until(() => stateFrames().length === 2)
  const delta = stateFrames()[1]
  assert.equal(delta.mode, 'delta')
  assert.equal(delta.seq, 2)
  assert.equal(delta.stateSeq, 7)
  assert.deepEqual(
    delta.changed.map((item) => [item.paneId, item.stateSeq]),
    [
      ['local:%1', 6],
      ['local:%2', 7],
    ],
  )
})

test('downgrades a congested delta to a pulse frame that still consumes a seq', async () => {
  let congested = false
  const { feed, stateFrames } = createFeed({ frameMs: 5, congested: () => congested })
  feed.subscribe({ hostId: 'local' })
  congested = true
  feed.ingest(changed('local', pane('local:%1', 'dev', 9)))
  await until(() => stateFrames().length === 2)
  const pulse = stateFrames()[1]
  assert.equal(pulse.mode, 'pulse')
  assert.equal(pulse.seq, 2)
  assert.equal(pulse.stateSeq, 9)
  assert.deepEqual(pulse.changed, [])
})

test('splits oversized deltas into frames with contiguous seq', async () => {
  const { feed, stateFrames } = createFeed({ frameMs: 5 })
  feed.subscribe({ hostId: 'local' })
  const panes = Array.from({ length: 65 }, (_, index) => pane(`local:%${index + 1}`, 'dev', index + 1))
  for (const item of panes) feed.ingest(changed('local', item))
  await until(() => stateFrames().length === 3)
  const frames = stateFrames().slice(1)
  assert.deepEqual(
    frames.map((frame) => [frame.seq, frame.changed.length]),
    [
      [2, 64],
      [3, 1],
    ],
  )
})

test('a full frame supersedes pending deltas so no stale update trails it', async () => {
  const { feed, stateFrames } = createFeed({ frameMs: 5 })
  feed.subscribe({ hostId: 'local' })
  feed.ingest(changed('local', pane('local:%1', 'dev', 3)))
  feed.ingest(snapshot('local', [pane('local:%2', 'dev', 4)]))
  assert.equal(stateFrames().length, 2)
  assert.equal(stateFrames()[1].mode, 'full')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stateFrames().length, 2)
})

test('removed and changed for the same pane collapse into the latest intent', async () => {
  const { feed, stateFrames } = createFeed({ frameMs: 5 })
  feed.subscribe({ hostId: 'local' })
  const target = pane('local:%1', 'dev', 4)
  feed.ingest(removed('local', target))
  feed.ingest(changed('local', { ...target, stateSeq: 5 }))
  await until(() => stateFrames().length === 2)
  const delta = stateFrames()[1]
  assert.deepEqual(delta.removed, [])
  assert.deepEqual(
    delta.changed.map((item) => item.stateSeq),
    [5],
  )
})

test('resync replays a full frame and rejects unknown subscriptions', () => {
  const { feed, stateFrames } = createFeed({ frameMs: 0, states: { local: [pane('local:%1', 'dev', 2)] } })
  const { subId } = feed.subscribe({ hostId: 'local' })
  assert.deepEqual(feed.resync(subId), { subId, seq: 2 })
  assert.equal(stateFrames()[1].mode, 'full')
  assert.throws(
    () => feed.resync('as_missing'),
    (error: unknown) => error instanceof AgentFeedError && error.code === 'AGENT_RESYNC_REQUIRED',
  )
})

test('needFull=false subscribes with a bare watermark pulse instead of pane detail', () => {
  const { feed, stateFrames } = createFeed({ frameMs: 0, states: { local: [pane('local:%1', 'dev', 12)] } })
  feed.subscribe({ hostId: 'local', needFull: false })
  const [frame] = stateFrames()
  assert.equal(frame.mode, 'pulse')
  assert.equal(frame.stateSeq, 12)
  assert.deepEqual(frame.changed, [])
})

test('notifications ride the subscription without consuming seq numbers', async () => {
  const { feed, frames, stateFrames } = createFeed({ frameMs: 5 })
  const { subId } = feed.subscribe({ hostId: 'local' })
  feed.ingest(notification('local', pane('local:%1', 'dev', 2, 'blocked')))
  const notify = frames.find((frame) => frame.type === 'agent_notification')
  assert.ok(notify && notify.type === 'agent_notification')
  assert.equal(notify.subId, subId)
  feed.ingest(changed('local', pane('local:%1', 'dev', 3)))
  await until(() => stateFrames().length === 2)
  assert.equal(stateFrames()[1].seq, 2)
})

test('ignores events for other hosts and panes outside the subscription', async () => {
  const { feed, stateFrames } = createFeed({ frameMs: 5 })
  feed.subscribe({ hostId: 'local', sessions: ['dev'] })
  feed.ingest(changed('remote', pane('remote:%1', 'dev', 2)))
  feed.ingest(changed('local', pane('local:%1', 'other', 3)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stateFrames().length, 1)
})

test('unsubscribe and dispose stop further frames', async () => {
  const { feed, stateFrames } = createFeed({ frameMs: 5 })
  const { subId } = feed.subscribe({ hostId: 'local' })
  assert.equal(feed.unsubscribe(subId), true)
  assert.equal(feed.unsubscribe(subId), false)
  feed.ingest(changed('local', pane('local:%1', 'dev', 2)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stateFrames().length, 1)
  feed.subscribe({ hostId: 'local' })
  feed.dispose()
  const afterDispose = stateFrames().length
  feed.ingest(changed('local', pane('local:%1', 'dev', 3)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stateFrames().length, afterDispose)
})

test('monitor_error and unknown events produce no frames', async () => {
  const { feed, frames } = createFeed({ frameMs: 0 })
  feed.subscribe({ hostId: 'local' })
  feed.ingest({ type: 'agent_monitor_error', initial: false, hostId: 'local', message: 'boom', retrying: true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(frames.filter((frame) => frame.type === 'agent_state').length, 1)
})
