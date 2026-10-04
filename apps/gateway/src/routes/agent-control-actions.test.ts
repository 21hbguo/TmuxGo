import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, sendTmuxKeys, TEST_TMUX_SESSION } from '../test-tmux.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import { _resetAgentOpsForTest, pendingAgentOpCount } from '../lib/agent-actions.js'
import { agentControlRoutes } from './agent-control.js'

// Task12 真实 tmux 用例：隔离 server 上的 test session（test-tmux.ts 约定）。
// mock agent = node 脚本名叫 claude：detectProcessAgent 走
// indirectCommands(node) + script basename(claude) → 命中 directAgents；
// 输出 esc to interrupt → working → lastEvent 'started'（ack 依据）
const mockbin = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-mockbin-'))
writeFileSync(
  path.join(mockbin, 'claude'),
  '#!/usr/bin/env node\n' +
    "process.stdout.write('MOCK_CLAUDE_READY esc to interrupt\\n')\n" +
    "process.stdin.on('data', (d) => process.stdout.write('GOT:' + d))\n" +
    'setInterval(() => {}, 1000)\n',
)
chmodSync(path.join(mockbin, 'claude'), 0o755)

const hostId = 'local'
const headers = { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' }

async function waitForPane(tmuxPaneId: string, ready: (command: string) => boolean) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { stdout } = await execTmuxFile('tmux', [
      'display-message',
      '-p',
      '-t',
      tmuxPaneId,
      '#{pane_current_command}',
    ])
    if (ready(stdout.trim())) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`pane ${tmuxPaneId} not ready`)
}
const capturePane = async (tmuxPaneId: string) =>
  (await execTmuxFile('tmux', ['capture-pane', '-p', '-t', tmuxPaneId])).stdout
// 新 pane：mockbin 进 PATH 才算可用（send-keys -l 与 Enter 分两次发，
// 否则 -l 会把 Enter 当字面量文本）
async function newShellPane(kind: 'split' | 'window' = 'split') {
  const { stdout } = await execTmuxFile('tmux', [
    kind === 'window' ? 'new-window' : 'split-window',
    '-d',
    '-t',
    TEST_TMUX_SESSION,
    '-P',
    '-F',
    '#{pane_id}',
  ])
  const id = stdout.trim()
  await waitForPane(id, (command) => ['bash', 'sh', 'zsh'].includes(command))
  await sendTmuxKeys(id, '-l', `export PATH=${mockbin}:$PATH`)
  await sendTmuxKeys(id, 'Enter')
  return id
}

test('agent start/prompt/cancel over real tmux', async (t) => {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
    agentMonitor.stop()
    _resetAgentOpsForTest()
  })
  await execTmuxFile('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', TEST_TMUX_SESSION])
  t.after(() => killTestTmuxSession())
  const fastify = Fastify()
  await fastify.register(agentControlRoutes)
  t.after(() => fastify.close())

  // ── start：idle shell 上启动 mock claude，ack 等 started 事件 ──
  const pane = await newShellPane()
  const start = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/start',
    headers,
    payload: { paneId: `${hostId}:${pane}`, provider: 'claude', ackTimeoutMs: 30000 },
  })
  assert.equal(start.statusCode, 200, start.body)
  const started = start.json()
  assert.equal(started.ok, true)
  assert.equal(started.acked, true)
  assert.ok(started.opId)
  await waitForPane(pane, (command) => command === 'node')
  assert.match(await capturePane(pane), /MOCK_CLAUDE_READY/)

  // ── prompt：literal 文本 + 独立 Enter，mock 回显 GOT: 证明到达 ──
  const prompt = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/prompt',
    headers,
    payload: { paneId: `${hostId}:${pane}`, prompt: 'marker-prompt-42', ackTimeoutMs: 30000 },
  })
  assert.equal(prompt.statusCode, 200, prompt.body)
  assert.equal(prompt.json().ok, true)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (/GOT:marker-prompt-42/.test(await capturePane(pane))) break
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (attempt === 39) assert.fail('prompt text did not reach the agent pane')
  }

  // ── cancel：codex 未装 → started 永不达 → pending，cancel 后 OPERATION_CANCELLED ──
  const idlePane = await newShellPane()
  const pendingStart = fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/start',
    headers,
    payload: { paneId: `${hostId}:${idlePane}`, provider: 'codex', ackTimeoutMs: 30000, opId: 'tmux-cancel-1' },
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const cancel = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/cancel',
    headers,
    payload: { opId: 'tmux-cancel-1' },
  })
  assert.equal(cancel.statusCode, 200)
  assert.equal(cancel.json().state, 'cancelled')
  const cancelled = await pendingStart
  assert.equal(cancelled.statusCode, 409)
  assert.equal(cancelled.json().code, 'OPERATION_CANCELLED')
  const repeat = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/cancel',
    headers,
    payload: { opId: 'tmux-cancel-1' },
  })
  assert.equal(repeat.json().state, 'already_settled')

  // ── quota：同 host 在途上限，超出 429；cancel 全部释放 ──
  // 8+ pane 单窗口 split 会 no space：quota 用 new-window（同 session）
  const quotaPanes = await Promise.all(Array.from({ length: 8 }, () => newShellPane('window')))
  const pendingQuota = quotaPanes.map((pane, index) =>
    fastify.inject({
      method: 'POST',
      url: '/v1/control/agent/start',
      headers,
      payload: { paneId: `${hostId}:${pane}`, provider: 'codex', ackTimeoutMs: 30000, opId: `quota-${index}` },
    }),
  )
  // 等 8 个 op 全部进入在途再触发上限，比固定 sleep 稳
  for (let attempt = 0; attempt < 100 && pendingAgentOpCount(hostId) < 8; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(pendingAgentOpCount(hostId), 8)
  const extraPane = await newShellPane()
  const over = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/start',
    headers,
    payload: { paneId: `${hostId}:${extraPane}`, provider: 'codex' },
  })
  assert.equal(over.statusCode, 429)
  assert.equal(over.json().code, 'AGENT_CONTROL_QUOTA_EXCEEDED')
  for (let index = 0; index < quotaPanes.length; index += 1)
    await fastify.inject({
      method: 'POST',
      url: '/v1/control/agent/cancel',
      headers,
      payload: { opId: `quota-${index}` },
    })
  const quotaResults = await Promise.all(pendingQuota)
  for (const response of quotaResults) assert.equal(response.json().code, 'OPERATION_CANCELLED')
})
