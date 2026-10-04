import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentActionError,
  _resetAgentOpsForTest,
  buildAgentStartCommand,
  cancelAgentOperation,
  maxPendingOpsPerHost,
  pendingAgentOpCount,
  promptAgentInPane,
  startAgentInPane,
  validateAgentPrompt,
  type AgentActionDeps,
} from './agent-actions.js'
import type { AgentPaneState } from './agent-state.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const rows = (...paneRows: string[][]) => new Map(paneRows.map((row) => [row[0], row] as const))
// paneInspectFormat 行：#{pane_id} cmd dead cwd session winIdx paneIdx inMode
const shellPane = (id = '%1') => rows([id, 'bash', '0', '/tmp', 'test', '0', '0', '0'])
const occupiedPane = (command = 'claude', id = '%1') => rows([id, command, '0', '/tmp', 'test', '0', '0', '0'])
const deadPane = (id = '%1') => rows([id, 'bash', '1', '/tmp', 'test', '0', '0', '0'])
const inModePane = (id = '%1') => rows([id, 'bash', '0', '/tmp', 'test', '0', '0', '1'])
const agentPane = (id = '%1'): AgentPaneState =>
  ({
    paneId: `local:${id}`,
    tmuxPaneId: id,
    sessionName: 'test',
    agent: 'claude',
    agentStatus: 'working',
  }) as AgentPaneState

function fakeDeps(overrides: Partial<AgentActionDeps> = {}) {
  const sent: string[][] = []
  const deps: AgentActionDeps = {
    exec: (async (_host: string, args: string[]) => {
      sent.push(args)
      return { stdout: '', stderr: '' }
    }) as unknown as AgentActionDeps['exec'],
    inspect: async () => shellPane(),
    scanAgents: async () => [agentPane()],
    sleep: async () => {},
    now: () => Date.now(),
    ...overrides,
  }
  return { deps, sent }
}
// 挂起 ack 的依赖：scan 永远空 + sleep 永不返回 → 只可能被 cancel/超时打断
function hangingDeps(overrides: Partial<AgentActionDeps> = {}) {
  return fakeDeps({
    scanAgents: async () => [],
    sleep: () => new Promise(() => {}),
    ...overrides,
  })
}

test('buildAgentStartCommand: allowlist provider and validated args only', () => {
  assert.equal(buildAgentStartCommand('claude'), 'claude')
  assert.equal(buildAgentStartCommand('codex', ['--resume', 'abc-123']), 'codex --resume abc-123')
  for (const provider of ['bash', 'sh', 'opencode', 'sudo', 'claude;rm'])
    assert.throws(() => buildAgentStartCommand(provider), AgentActionError)
  for (const arg of ['$(id)', 'a;id', 'a|id', 'a&id', '`id`', 'a id', '', '--flag=ok;rm', '-n\nrm'])
    assert.throws(() => buildAgentStartCommand('claude', [arg]), AgentActionError)
  assert.throws(() => buildAgentStartCommand('claude', Array(9).fill('a')), AgentActionError)
})

test('validateAgentPrompt: length cap and control characters', () => {
  validateAgentPrompt('hello\nworld\ttab')
  assert.throws(() => validateAgentPrompt(''), AgentActionError)
  assert.throws(() => validateAgentPrompt('x'.repeat(8193)), AgentActionError)
  assert.throws(() => validateAgentPrompt('bad' + String.fromCharCode(0) + 'rest'), AgentActionError)
  assert.throws(() => validateAgentPrompt('bad' + String.fromCharCode(7) + 'bell'), AgentActionError)
  assert.throws(() => validateAgentPrompt('bad' + String.fromCharCode(27) + 'esc'), AgentActionError)
})

test('startAgentInPane: five-state pane rejection', async () => {
  const states = [
    [async () => null, 'PANE_UNKNOWN'],
    [async () => rows(), 'PANE_MISSING'],
    [async () => deadPane(), 'PANE_DEAD'],
    [async () => inModePane(), 'PANE_IN_MODE'],
    [async () => occupiedPane('vim'), 'PANE_OCCUPIED'],
  ] as const
  for (const [inspect, code] of states) {
    const { deps } = fakeDeps({ inspect })
    await assert.rejects(
      startAgentInPane('local', '%1', { provider: 'claude' }, deps),
      (e: AgentActionError) => e.code === code,
    )
  }
})

test('startAgentInPane: sends literal command + separate Enter on idle shell', async () => {
  const { deps, sent } = fakeDeps()
  const result = await startAgentInPane('local', '%1', { provider: 'codex', args: ['--resume', 'abc'] }, deps)
  assert.equal(result.acked, false)
  assert.ok(result.opId)
  assert.deepEqual(sent, [
    ['send-keys', '-l', '-t', 'test:0.0', 'codex --resume abc'],
    ['send-keys', '-t', 'test:0.0', 'Enter'],
  ])
  assert.equal(pendingAgentOpCount('local'), 0)
})

test('promptAgentInPane: only on agent-occupied pane, literal + Enter', async () => {
  const shell = fakeDeps()
  await assert.rejects(
    promptAgentInPane('local', '%1', { prompt: 'hi' }, shell.deps),
    (e: AgentActionError) => e.code === 'PANE_NOT_AGENT',
  )
  const occupiedNotAgent = fakeDeps({ inspect: async () => occupiedPane('vim'), scanAgents: async () => [] })
  await assert.rejects(
    promptAgentInPane('local', '%1', { prompt: 'hi' }, occupiedNotAgent.deps),
    (e: AgentActionError) => e.code === 'PANE_NOT_AGENT',
  )
  const { deps, sent } = fakeDeps({ inspect: async () => occupiedPane('claude') })
  const result = await promptAgentInPane('local', '%1', { prompt: 'run the tests; with $(chars)' }, deps)
  assert.equal(result.acked, false)
  assert.deepEqual(sent[0], ['send-keys', '-l', '-t', 'test:0.0', 'run the tests; with $(chars)'])
  assert.deepEqual(sent[1], ['send-keys', '-t', 'test:0.0', 'Enter'])
})

test('ack wait: agent appearing resolves acked; absent agent yields ACK_TIMEOUT', async () => {
  const ok = fakeDeps()
  const acked = await startAgentInPane('local', '%1', { provider: 'claude', ackTimeoutMs: 5000 }, ok.deps)
  assert.equal(acked.acked, true)
  assert.equal(acked.pane?.agent, 'claude')
  // 虚拟时钟即时到期
  let now = 0
  const timeoutDeps = fakeDeps({ scanAgents: async () => [], now: () => now, sleep: async () => void (now += 300) })
  await assert.rejects(
    startAgentInPane('local', '%1', { provider: 'claude', ackTimeoutMs: 250 }, timeoutDeps.deps),
    (e: AgentActionError) => e.code === 'ACK_TIMEOUT',
  )
  assert.equal(pendingAgentOpCount('local'), 0)
})

test('quota: per-host cap hit rejects, cancel releases slots', async () => {
  _resetAgentOpsForTest()
  const { deps } = hangingDeps()
  const pending = Array.from({ length: maxPendingOpsPerHost }, (_, index) =>
    startAgentInPane('local', '%1', { provider: 'claude', ackTimeoutMs: 30000, opId: `q-${index}` }, deps),
  )
  await tick()
  await tick()
  assert.equal(pendingAgentOpCount('local'), maxPendingOpsPerHost)
  await assert.rejects(
    startAgentInPane('local', '%1', { provider: 'claude' }, deps),
    (e: AgentActionError) => e.code === 'AGENT_CONTROL_QUOTA_EXCEEDED',
  )
  for (let index = 0; index < maxPendingOpsPerHost; index += 1)
    assert.deepEqual(cancelAgentOperation(`q-${index}`), { state: 'cancelled' })
  await Promise.allSettled(pending)
  assert.equal(pendingAgentOpCount('local'), 0)
  const ok = await startAgentInPane('local', '%1', { provider: 'claude' }, deps)
  assert.ok(ok.opId)
})

test('send failure releases quota and propagates', async () => {
  _resetAgentOpsForTest()
  const { deps } = fakeDeps({
    exec: (async () => {
      throw new Error('tmux gone')
    }) as unknown as AgentActionDeps['exec'],
  })
  await assert.rejects(
    startAgentInPane('local', '%1', { provider: 'claude' }, deps),
    (e: AgentActionError) => e.code === 'AGENT_CONTROL_SEND_FAILED',
  )
  assert.equal(pendingAgentOpCount('local'), 0)
})

test('cancel: pending op rejected with OPERATION_CANCELLED via client opId', async () => {
  _resetAgentOpsForTest()
  const { deps } = hangingDeps()
  const attempt = startAgentInPane(
    'local',
    '%1',
    { provider: 'claude', ackTimeoutMs: 30000, opId: 'op-cancel-1' },
    deps,
  )
  await tick()
  await tick()
  assert.equal(pendingAgentOpCount('local'), 1)
  assert.deepEqual(cancelAgentOperation('op-cancel-1'), { state: 'cancelled' })
  await assert.rejects(attempt, (e: AgentActionError) => e.code === 'OPERATION_CANCELLED')
  assert.equal(pendingAgentOpCount('local'), 0)
  assert.deepEqual(cancelAgentOperation('op-cancel-1'), { state: 'already_settled' }) // 重复幂等
  await assert.rejects(
    startAgentInPane('local', '%1', { provider: 'claude', opId: 'op-cancel-1' }, deps),
    (e: AgentActionError) => e.code === 'INVALID_ARGUMENT',
  )
})

test('cancel lifecycle: not_found / already_settled after acked', async () => {
  _resetAgentOpsForTest()
  assert.deepEqual(cancelAgentOperation('nonexistent-op'), { state: 'not_found' })
  const { deps } = fakeDeps()
  const done = await startAgentInPane('local', '%1', { provider: 'claude' }, deps)
  assert.deepEqual(cancelAgentOperation(done.opId), { state: 'already_settled' })
  assert.deepEqual(cancelAgentOperation(done.opId), { state: 'already_settled' }) // 重复幂等
  const acked = await startAgentInPane('local', '%1', { provider: 'claude', ackTimeoutMs: 30000 }, deps)
  assert.equal(acked.acked, true)
  assert.deepEqual(cancelAgentOperation(acked.opId), { state: 'already_settled' })
  assert.equal(pendingAgentOpCount('local'), 0)
})
