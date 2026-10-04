import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { agentControlRoutes } from './agent-control.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
const headers = { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' }
async function firstPaneId() {
  const { stdout } = await execTmuxFile('tmux', ['list-panes', '-s', '-t', TEST_TMUX_SESSION, '-F', '#{pane_id}'])
  return stdout.trim().split('\n')[0]
}
// new-session 的 pane 进程异步就绪：snapshot/run/wait-output 前先等 shell 出现
async function waitForPane(paneId: string, ready: (command: string) => boolean) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { stdout } = await execTmuxFile('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_command}'])
    if (ready(stdout.trim())) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const shellReady = (command: string) => !!command && command !== 'tmux'
async function capturePane(paneId: string) {
  const { stdout } = await execTmuxFile('tmux', ['capture-pane', '-p', '-t', paneId])
  return stdout
}
async function freshServer(command?: string) {
  const args = ['-f', '/dev/null', 'new-session', '-d', '-s', TEST_TMUX_SESSION]
  if (command) args.push(command)
  await execTmuxFile('tmux', args)
}
function withFastify(t: test.TestContext) {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  const fastify = Fastify()
  t.after(async () => {
    await fastify.close()
    await killTestTmuxSession()
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
  })
  return fastify.register(agentControlRoutes).then(() => fastify)
}

test('panes/snapshot returns structured state without sensitive fields', async (t) => {
  const fastify = await withFastify(t)
  await freshServer()
  const paneId = await firstPaneId()
  await waitForPane(paneId, shellReady)
  await execTmuxFile('tmux', ['send-keys', '-l', '-t', paneId, 'echo snap-marker'])
  await execTmuxFile('tmux', ['send-keys', '-t', paneId, 'Enter'])
  await new Promise((resolve) => setTimeout(resolve, 300))
  const res = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/snapshot',
    headers,
    payload: { paneId: `local:${paneId}`, lines: 20 },
  })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  const snap = body.snapshot
  assert.equal(snap.tmuxPaneId, paneId)
  assert.equal(snap.sessionName, TEST_TMUX_SESSION)
  assert.equal(snap.dead, false)
  assert.ok(snap.size.cols > 0 && snap.size.rows > 0)
  assert.ok(snap.tail.some((line: string) => line.includes('snap-marker')))
  // 契约边界：无 env/token/无限历史字段
  assert.deepEqual(Object.keys(snap).sort(), [
    'active',
    'command',
    'cwd',
    'dead',
    'inMode',
    'paneId',
    'paneIndex',
    'sessionName',
    'size',
    'tail',
    'title',
    'tmuxPaneId',
    'windowIndex',
  ])
  // 不存在的 pane → 409 PANE_MISSING
  const missing = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/snapshot',
    headers,
    payload: { paneId: 'local:%999' },
  })
  assert.equal(missing.statusCode, 409)
  assert.equal(missing.json().code, 'PANE_MISSING')
})

test('panes/run types literal text into a shell pane and wait-output matches it', async (t) => {
  const fastify = await withFastify(t)
  await freshServer()
  const paneId = await firstPaneId()
  await waitForPane(paneId, shellReady)
  const run = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/run',
    headers,
    payload: { paneId: `local:${paneId}`, text: 'echo run-marker-42' },
  })
  assert.equal(run.statusCode, 200, run.body)
  // wait-output 在输出落地后匹配（run 与 capture 之间存在短暂延迟，交给 match 轮询）
  const waited = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/wait-output',
    headers,
    payload: { paneId: `local:${paneId}`, match: 'run-marker-42', timeoutMs: 5000 },
  })
  assert.equal(waited.statusCode, 200, waited.body)
  const body = waited.json()
  assert.equal(body.matched, true)
  assert.ok(body.output.includes('run-marker-42'))
})

test('panes/run gates occupied panes and rejects control-char input', async (t) => {
  const fastify = await withFastify(t)
  await freshServer('cat')
  const paneId = await firstPaneId()
  await waitForPane(paneId, (command) => command === 'cat')
  const occupied = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/run',
    headers,
    payload: { paneId: `local:${paneId}`, text: 'should-not-send' },
  })
  assert.equal(occupied.statusCode, 409)
  assert.equal(occupied.json().code, 'PANE_OCCUPIED')
  assert.ok(!(await capturePane(paneId)).includes('should-not-send'))
  // 显式 allowOccupied 后字面文本送达（cat 回显输入）
  const confirmed = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/run',
    headers,
    payload: { paneId: `local:${paneId}`, text: 'explicit-occupied-input', allowOccupied: true },
  })
  assert.equal(confirmed.statusCode, 200, confirmed.body)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok((await capturePane(paneId)).includes('explicit-occupied-input'))
  // 控制字符注入 → 400 INVALID_INPUT，按键不发生
  for (const text of ['a\nb', 'x\x1b[2J', 'q\ry']) {
    const injected = await fastify.inject({
      method: 'POST',
      url: '/v1/control/panes/run',
      headers,
      payload: { paneId: `local:${paneId}`, text },
    })
    assert.equal(injected.statusCode, 400)
    assert.equal(injected.json().code, 'INVALID_INPUT')
  }
})

test('panes/wait-output times out and fails on removed panes explicably', async (t) => {
  const fastify = await withFastify(t)
  await freshServer('sleep 300')
  const paneId = await firstPaneId()
  await waitForPane(paneId, (command) => command === 'sleep')
  const timeout = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/wait-output',
    headers,
    payload: { paneId: `local:${paneId}`, match: 'never-appears', timeoutMs: 400 },
  })
  assert.equal(timeout.statusCode, 409)
  assert.equal(timeout.json().code, 'TIMEOUT')
  // 等待期间 pane 被移除 → PANE_REMOVED（kill-pane 只关目标 pane，不动 session）
  const paneRemoved = fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/wait-output',
    headers,
    payload: { paneId: `local:${paneId}`, match: 'never', timeoutMs: 30000 },
  })
  await new Promise((resolve) => setTimeout(resolve, 400))
  await execTmuxFile('tmux', ['kill-pane', '-t', paneId])
  const removed = await paneRemoved
  assert.equal(removed.statusCode, 409)
  assert.equal(removed.json().code, 'PANE_REMOVED')
})

test('panes/wait-output reports occupant change during wait', async (t) => {
  const fastify = await withFastify(t)
  await freshServer()
  const paneId = await firstPaneId()
  await waitForPane(paneId, shellReady)
  const waiting = fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/wait-output',
    headers,
    payload: { paneId: `local:${paneId}`, match: 'never-appears', timeoutMs: 30000 },
  })
  // shell → sleep：occupant 在条件满足前变更必须使等待失败
  await new Promise((resolve) => setTimeout(resolve, 400))
  await execTmuxFile('tmux', ['send-keys', '-l', '-t', paneId, 'sleep 5'])
  await execTmuxFile('tmux', ['send-keys', '-t', paneId, 'Enter'])
  const res = await waiting
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'OCCUPANT_CHANGED')
})
