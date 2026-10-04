import '../test-env.js'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import {
  AgentControl,
  AgentWaitError,
  resolveAgentWaitTarget,
  runAgentPaneInput,
  snapshotAgentPane,
  waitAgentPaneOutput,
} from './agent-control.js'
import type { AgentPaneState } from './agent-state.js'
import type { AgentMonitorEvent } from './agent-monitor.js'
import type { RecoveryPaneInspection } from './agent-recovery.js'

function pane(paneId: string, overrides: Partial<AgentPaneState> = {}): AgentPaneState {
  return {
    paneId,
    tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1),
    sessionName: 'dev',
    agent: 'codex',
    agentSessionId: paneId + ':dev',
    agentStatus: 'working',
    phase: 'working',
    lastEvent: 'started',
    source: 'process',
    confidence: 'medium',
    since: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:01.000Z',
    eventId: paneId + ':started',
    revision: 1,
    ...overrides,
  }
}
function stateWith(panes: AgentPaneState[]) {
  return { states: panes, emit: [] as AgentMonitorEvent[] }
}
function createControl(initial: AgentPaneState[]) {
  const holder = stateWith(initial)
  const listeners = new Set<(event: AgentMonitorEvent) => void>()
  const control = new AgentControl({
    now: () => 1000,
    getStates: () => holder.states,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    scanStates: async () => holder.states,
  })
  const emit = (event: AgentMonitorEvent) => {
    for (const listener of listeners) listener(event)
  }
  return { control, holder, emit, listeners }
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
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    pane: pane('local:%1', {
      agentStatus: 'blocked',
      phase: 'permission_required',
      lastEvent: 'permission_required',
      eventId: 'e1',
      revision: 2,
    }),
    eventId: 'e1',
  })
  const result = await promise
  assert.equal(result.pane.agentStatus, 'blocked')
  assert.equal(result.elapsedMs, 0)
})
test('rejects with OCCUPANT_CHANGED when the pinned occupant is replaced', async () => {
  const { control, emit } = createControl([pane('local:%1', { agent: 'codex', agentSessionId: 'local:%1:dev' })])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'blocked' })
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    pane: pane('local:%1', {
      agent: 'claude',
      agentSessionId: 'local:%1:other',
      agentStatus: 'blocked',
      phase: 'permission_required',
      lastEvent: 'permission_required',
      eventId: 'e2',
      revision: 2,
    }),
    eventId: 'e2',
  })
  await assert.rejects(promise, (error: AgentWaitError) => error.code === 'OCCUPANT_CHANGED')
})
test('rejects with PANE_REMOVED when the target pane disappears', async () => {
  const { control, emit } = createControl([pane('local:%1')])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'blocked' })
  emit({
    type: 'agent_status_removed',
    initial: false,
    hostId: 'local',
    paneId: 'local:%1',
    sessionName: 'dev',
    reason: 'pane_exited',
    eventId: 'r1',
  })
  await assert.rejects(promise, (error: AgentWaitError) => error.code === 'PANE_REMOVED')
})
test('rejects with TIMEOUT when the condition is never met', async () => {
  const { control } = createControl([pane('local:%1')])
  await assert.rejects(
    control.wait({ paneId: 'local:%1' }, { status: 'blocked' }, { timeoutMs: 250, now: () => Date.now() }),
    (error: AgentWaitError) => error.code === 'TIMEOUT',
  )
})
test('waits by sessionName and agent and rejects when occupied by another agent', async () => {
  const { control, emit } = createControl([pane('local:%1', { agent: 'opencode' })])
  const promise = control.wait({ sessionName: 'dev', agent: 'codex' }, { status: 'blocked' })
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    pane: pane('local:%1', {
      agent: 'opencode',
      agentStatus: 'blocked',
      phase: 'permission_required',
      lastEvent: 'permission_required',
      eventId: 'e3',
      revision: 2,
    }),
    eventId: 'e3',
  })
  await assert.rejects(promise, (error: AgentWaitError) => error.code === 'OCCUPANT_CHANGED')
})
test('rejects invalid targets and empty conditions', async () => {
  const { control } = createControl([])
  await assert.rejects(
    control.wait({ paneId: 'bad' } as never, { status: 'blocked' }),
    (error: AgentWaitError) => error.code === 'INVALID_TARGET',
  )
  await assert.rejects(
    control.wait({ paneId: 'local:%1' }, {}),
    (error: AgentWaitError) => error.code === 'INVALID_TARGET',
  )
  assert.throws(
    () => resolveAgentWaitTarget({ sessionName: '', agent: '' }),
    (error: AgentWaitError) => error.code === 'INVALID_TARGET',
  )
})
test('ignores stale pre-wait state replays and resolves only on fresh changes', async () => {
  const { control, emit } = createControl([
    pane('local:%1', { agentStatus: 'idle', phase: 'idle', lastEvent: 'completed', stateSeq: 7 }),
  ])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'done' })
  emit({
    type: 'agent_status_snapshot',
    initial: true,
    hostId: 'local',
    revision: 1,
    agents: [pane('local:%1', { agentStatus: 'done', phase: 'idle', lastEvent: 'completed', stateSeq: 5 })],
    eventId: 'snap1',
  })
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    pane: pane('local:%1', {
      agentStatus: 'done',
      phase: 'idle',
      lastEvent: 'completed',
      stateSeq: 7,
      eventId: 'stale',
      revision: 2,
    }),
    eventId: 'stale',
  })
  assert.equal(control.activeWaitCount(), 1)
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    pane: pane('local:%1', {
      agentStatus: 'done',
      phase: 'idle',
      lastEvent: 'completed',
      stateSeq: 8,
      eventId: 'fresh',
      revision: 3,
    }),
    eventId: 'fresh',
  })
  const result = await promise
  assert.equal(result.pane.stateSeq, 8)
  assert.equal(control.activeWaitCount(), 0)
})
test('still resolves on stateSeq-less panes when a wait baseline exists', async () => {
  const { control, emit } = createControl([pane('local:%1', { stateSeq: 7 })])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'done' })
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    pane: pane('local:%1', { agentStatus: 'done', phase: 'idle', lastEvent: 'completed', eventId: 'e9', revision: 2 }),
    eventId: 'e9',
  })
  await promise
  assert.equal(control.activeWaitCount(), 0)
})
test('cancels an active agent wait when the client aborts', async () => {
  const { control, listeners } = createControl([pane('local:%1')])
  const controller = new AbortController()
  const pending = control.wait({ paneId: 'local:%1' }, { status: 'done' }, { signal: controller.signal })
  assert.equal(control.activeWaitCount(), 1)
  controller.abort()
  await assert.rejects(pending, (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED')
  assert.equal(control.activeWaitCount(), 0)
  assert.equal(listeners.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('rejects pre-aborted waits even when the initial state matches', async () => {
  const { control, listeners } = createControl([pane('local:%1', { agentStatus: 'done' })])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    control.wait({ paneId: 'local:%1' }, { status: 'done' }, { signal: controller.signal }),
    (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED',
  )
  assert.equal(control.activeWaitCount(), 0)
  assert.equal(listeners.size, 0)
})

test('rejects aborts during the initial scan before accepting a matching state', async () => {
  const controller = new AbortController()
  const control = new AgentControl({
    getStates: () => null,
    scanStates: async () => {
      controller.abort()
      return [pane('local:%1', { agentStatus: 'done' })]
    },
  })
  await assert.rejects(
    control.wait({ paneId: 'local:%1' }, { status: 'done' }, { signal: controller.signal }),
    (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED',
  )
  assert.equal(control.activeWaitCount(), 0)
})

test('aborting one wait preserves another and removes listeners on completion', async () => {
  const { control, emit, listeners } = createControl([pane('local:%1')])
  const first = new AbortController()
  const second = new AbortController()
  const cancelled = control.wait({ paneId: 'local:%1' }, { status: 'done' }, { signal: first.signal })
  const pending = control.wait({ paneId: 'local:%1' }, { status: 'done' }, { signal: second.signal })
  first.abort()
  await assert.rejects(cancelled, (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED')
  assert.equal(control.activeWaitCount(), 1)
  assert.equal(listeners.size, 1)
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    eventId: 'task15:done',
    pane: pane('local:%1', { agentStatus: 'done' }),
  })
  await pending
  assert.equal(control.activeWaitCount(), 0)
  assert.equal(listeners.size, 0)
  assert.equal(getEventListeners(second.signal, 'abort').length, 0)
  second.abort()
})

test('timeout removes abort listeners and the monitor subscription', async () => {
  const { control, listeners } = createControl([pane('local:%1')])
  const controller = new AbortController()
  await assert.rejects(
    control.wait({ paneId: 'local:%1' }, { status: 'done' }, { signal: controller.signal, timeoutMs: 250 }),
    (error: AgentWaitError) => error.code === 'TIMEOUT',
  )
  assert.equal(control.activeWaitCount(), 0)
  assert.equal(listeners.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('tracks active wait count and cleans up after resolution', async () => {
  const { control, emit } = createControl([pane('local:%1')])
  const promise = control.wait({ paneId: 'local:%1' }, { status: 'done' })
  assert.equal(control.activeWaitCount(), 1)
  emit({
    type: 'agent_status_changed',
    initial: false,
    hostId: 'local',
    sessionName: 'dev',
    pane: pane('local:%1', { agentStatus: 'done', phase: 'idle', lastEvent: 'completed', eventId: 'e4', revision: 2 }),
    eventId: 'e4',
  })
  await promise
  assert.equal(control.activeWaitCount(), 0)
})

// ---- Task9：snapshot / wait-output / run（exec/inspect 全注入，不触真实 tmux） ----
type ExecCalls = { args: string[] }[]
function fakeExec(handler: (args: string[]) => string | Error) {
  const calls: ExecCalls = []
  const exec = async (_host: string, args: string[]) => {
    calls.push({ args })
    const out = handler(args)
    if (out instanceof Error) throw out
    return { stdout: out }
  }
  return { exec, calls }
}
const snapshotRow = '%1\ttest\t0\t1\tzsh\tmy title\t/repo\t0\t0\t80\t24\t1'
test('snapshot returns capped structured fields and bounded tail', async () => {
  const long = 'x'.repeat(500)
  const { exec } = fakeExec((args) => (args[0] === 'display-message' ? snapshotRow : `line1\n${long}\nline3\n`))
  const snapshot = await snapshotAgentPane('local', '%1', 50, exec)
  assert.equal(snapshot.paneId, 'local:%1')
  assert.equal(snapshot.command, 'zsh')
  assert.equal(snapshot.title, 'my title')
  assert.equal(snapshot.cwd, '/repo')
  assert.deepEqual(snapshot.size, { cols: 80, rows: 24 })
  assert.equal(snapshot.dead, false)
  assert.equal(snapshot.tail.length, 3)
  // 行长封顶 200、行数按请求上限截取
  assert.equal(snapshot.tail[1].length, 200)
  const capped = await snapshotAgentPane('local', '%1', 1, exec)
  assert.deepEqual(capped.tail, ['line3'])
})
test('snapshot tail enforces the total size cap', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}-${'y'.repeat(190)}`).join('\n')
  const { exec } = fakeExec((args) => (args[0] === 'display-message' ? snapshotRow : lines))
  const snapshot = await snapshotAgentPane('local', '%1', 100, exec)
  assert.ok(snapshot.tail.join('\n').length <= 8192)
  assert.ok(snapshot.tail[snapshot.tail.length - 1].startsWith('line-99'))
})
test('snapshot maps a missing pane to PANE_MISSING', async () => {
  const { exec } = fakeExec(() => new Error('no such pane'))
  await assert.rejects(snapshotAgentPane('local', '%99', 12, exec), (e: AgentWaitError) => e.code === 'PANE_MISSING')
})
test('wait-output resolves on literal and regex matches', async () => {
  const noDelay = () => Promise.resolve()
  const lit = fakeExec((args) => (args[0] === 'display-message' ? 'zsh\t0' : 'prompt$ ok\n'))
  const litResult = await waitAgentPaneOutput('local', '%1', { match: 'ok', exec: lit.exec, sleep: noDelay })
  assert.equal(litResult.matched, true)
  assert.equal(litResult.elapsedMs, 0)
  const re = fakeExec((args) => (args[0] === 'display-message' ? 'zsh\t0' : 'exit code 42\n'))
  const reResult = await waitAgentPaneOutput('local', '%1', {
    match: 'code \\d+',
    regex: true,
    exec: re.exec,
    sleep: noDelay,
  })
  assert.equal(reResult.matched, true)
  await assert.rejects(
    waitAgentPaneOutput('local', '%1', { match: '([', regex: true, exec: lit.exec, sleep: noDelay }),
    (e: AgentWaitError) => e.code === 'INVALID_PATTERN',
  )
})
test('wait-output resolves on output change and reports elapsed', async () => {
  let tick = 0
  const exec = fakeExec((args) => {
    if (args[0] === 'display-message') return 'zsh\t0'
    tick += 1
    return tick === 1 ? 'stable\n' : 'stable\nnew output\n'
  })
  let now = 1000
  const result = await waitAgentPaneOutput('local', '%1', {
    exec: exec.exec,
    sleep: async () => {
      now += 300
    },
    now: () => now,
  })
  assert.equal(result.changed, true)
  assert.ok(result.output.includes('new output'))
})
test('wait-output cancels promptly when the client aborts', async () => {
  const controller = new AbortController()
  const staticOut = fakeExec((args) => (args[0] === 'display-message' ? 'zsh\t0' : 'same\n'))
  const pending = waitAgentPaneOutput('local', '%1', {
    match: 'never',
    timeoutMs: 30000,
    exec: staticOut.exec,
    sleep: async () => controller.abort(),
    signal: controller.signal,
  })
  await assert.rejects(pending, (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED')
})

test('wait-output abort interrupts a long poll timer and removes its listener', async (t) => {
  const controller = new AbortController()
  const staticOut = fakeExec((args) => (args[0] === 'display-message' ? 'zsh\t0' : 'same\n'))
  const pending = waitAgentPaneOutput('local', '%1', {
    match: 'never',
    pollMs: 5000,
    exec: staticOut.exec,
    signal: controller.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  const watchdog = setTimeout(() => controller.abort(), 1000)
  t.after(() => clearTimeout(watchdog))
  controller.abort()
  await assert.rejects(pending, (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(staticOut.calls.length, 2)
})

test('wait-output rejects pre-aborted requests without reading a pane', async () => {
  const controller = new AbortController()
  controller.abort()
  const staticOut = fakeExec(() => 'unused')
  await assert.rejects(
    waitAgentPaneOutput('local', '%1', { signal: controller.signal, exec: staticOut.exec }),
    (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED',
  )
  assert.equal(staticOut.calls.length, 0)
})

test('wait-output rejects cancellation during a read instead of returning a match', async () => {
  const controller = new AbortController()
  const staticOut = fakeExec((args) => {
    if (args[0] === 'capture-pane') controller.abort()
    return args[0] === 'display-message' ? 'zsh\t0' : 'matched\n'
  })
  await assert.rejects(
    waitAgentPaneOutput('local', '%1', { match: 'matched', signal: controller.signal, exec: staticOut.exec }),
    (error: AgentWaitError) => error.code === 'CLIENT_DISCONNECTED',
  )
})

test('wait-output fails TIMEOUT, PANE_REMOVED and OCCUPANT_CHANGED explicably', async () => {
  const noDelay = () => Promise.resolve()
  const staticOut = fakeExec((args) => (args[0] === 'display-message' ? 'zsh\t0' : 'same\n'))
  await assert.rejects(
    waitAgentPaneOutput('local', '%1', { match: 'never', timeoutMs: 260, exec: staticOut.exec, sleep: noDelay }),
    (e: AgentWaitError) => e.code === 'TIMEOUT',
  )
  let step = 0
  const gone = fakeExec((args) => {
    step += 1
    if (step > 2) return new Error('pane gone')
    return args[0] === 'display-message' ? 'zsh\t0' : 'x\n'
  })
  await assert.rejects(
    waitAgentPaneOutput('local', '%1', { match: 'zzz', timeoutMs: 30000, exec: gone.exec, sleep: noDelay }),
    (e: AgentWaitError) => e.code === 'PANE_REMOVED',
  )
  let poll = 0
  const swapped = fakeExec((args) => {
    poll += 1
    if (args[0] === 'display-message') return poll <= 2 ? 'zsh\t0' : 'vim\t0'
    return 'unchanged\n'
  })
  await assert.rejects(
    waitAgentPaneOutput('local', '%1', { match: 'zzz', timeoutMs: 30000, exec: swapped.exec, sleep: noDelay }),
    (e: AgentWaitError) => e.code === 'OCCUPANT_CHANGED',
  )
})
const inspectAs = (state: RecoveryPaneInspection['state'], command = 'zsh'): RecoveryPaneInspection =>
  state === 'missing' ? { state } : { state, command, cwd: '/repo', target: 'test:0.1' }
test('run rejects control-char input and unconfirmed occupied panes', async () => {
  const { exec, calls } = fakeExec(() => '')
  const shellInspect = async () => inspectAs('shell')
  for (const bad of ['echo\x00hi', 'line1\nline2', 'a\rb', 'esc\x1b[', '']) {
    await assert.rejects(
      runAgentPaneInput('local', '%1', { text: bad, exec, inspect: shellInspect }),
      (e: AgentWaitError) => e.code === 'INVALID_INPUT',
      JSON.stringify(bad),
    )
  }
  assert.equal(calls.length, 0)
  const occupiedInspect = async () => inspectAs('occupied', 'vim')
  await assert.rejects(
    runAgentPaneInput('local', '%1', { text: 'q', exec, inspect: occupiedInspect }),
    (e: AgentWaitError) => e.code === 'PANE_OCCUPIED',
  )
})
test('run maps pane states to codes and sends literal keys + Enter', async () => {
  const { exec, calls } = fakeExec(() => '')
  for (const [state, code] of [
    ['missing', 'PANE_MISSING'],
    ['dead', 'PANE_DEAD'],
    ['in_mode', 'PANE_IN_MODE'],
  ] as const) {
    await assert.rejects(
      runAgentPaneInput('local', '%1', { text: 'ls', exec, inspect: async () => inspectAs(state) }),
      (e: AgentWaitError) => e.code === code,
    )
  }
  const result = await runAgentPaneInput('local', '%1', {
    text: 'echo hi',
    exec,
    inspect: async () => inspectAs('shell'),
  })
  assert.equal(result.target, 'test:0.1')
  // 字面 -l + 坐标 target；Enter 独立下发，杜绝 key-name 解析注入
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['send-keys', '-l', '-t', 'test:0.1', 'echo hi'],
      ['send-keys', '-t', 'test:0.1', 'Enter'],
    ],
  )
  calls.length = 0
  await runAgentPaneInput('local', '%1', {
    text: 'y',
    enter: false,
    allowOccupied: true,
    exec,
    inspect: async () => inspectAs('occupied', 'cat'),
  })
  assert.deepEqual(
    calls.map((c) => c.args),
    [['send-keys', '-l', '-t', 'test:0.1', 'y']],
  )
})
