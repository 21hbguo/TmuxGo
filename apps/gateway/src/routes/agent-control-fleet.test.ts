import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { agentControlRoutes } from './agent-control.js'

// 机队读面 + 任务号绑定的控制面契约测试。
// 这里不启 monitor、不碰 tmux：只锁「守卫 / 空机队形状 / 校验错误」这三条不需要真实 pane 的语义；
// 排序与过滤语义由 lib/fleet.test.ts 的纯函数用例覆盖（真实 tmux 写入路径在 panes 路由已有覆盖）。
const headers = { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' }

function withFastify(t: test.TestContext) {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  const fastify = Fastify()
  t.after(async () => {
    await fastify.close()
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
  })
  return fastify.register(agentControlRoutes).then(() => fastify)
}

test('fleet/list requires the agent token and the env guard', async (t) => {
  const fastify = await withFastify(t)
  const noToken = await fastify.inject({
    method: 'POST',
    url: '/v1/control/fleet/list',
    headers: { 'x-tmuxgo-env': '1' },
    payload: {},
  })
  assert.equal(noToken.statusCode, 401)
  assert.equal(noToken.json().code, 'AGENT_CONTROL_AUTH_REQUIRED')
  const noEnv = await fastify.inject({
    method: 'POST',
    url: '/v1/control/fleet/list',
    headers: { 'x-tmuxgo-agent-token': 'agent-control-secret' },
    payload: {},
  })
  assert.equal(noEnv.statusCode, 403)
  assert.equal(noEnv.json().code, 'TMUXGO_ENV_GUARD')
})

test('fleet/list returns an empty page shape when no agent pane is tracked', async (t) => {
  const fastify = await withFastify(t)
  const res = await fastify.inject({ method: 'POST', url: '/v1/control/fleet/list', headers, payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.panes, [])
  assert.deepEqual(body.summary, { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 })
  assert.equal(body.truncated, false)
  assert.match(body.capturedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('fleet/list rejects out-of-range filters before touching the monitor', async (t) => {
  const fastify = await withFastify(t)
  const tooMany = await fastify.inject({
    method: 'POST',
    url: '/v1/control/fleet/list',
    headers,
    payload: { limit: 501 },
  })
  assert.equal(tooMany.statusCode, 400)
  assert.equal(tooMany.json().code, 'AGENT_CONTROL_FLEET_FAILED')
  const badStatus = await fastify.inject({
    method: 'POST',
    url: '/v1/control/fleet/list',
    headers,
    payload: { statuses: ['exploded'] },
  })
  assert.equal(badStatus.statusCode, 400)
})

test('panes/task rejects a missing task field without touching tmux', async (t) => {
  const fastify = await withFastify(t)
  const res = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/task',
    headers,
    payload: { paneId: 'local:%0' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'AGENT_CONTROL_TASK_FAILED')
})

test('panes/task rejects newlines that would corrupt the pane list', async (t) => {
  // @tmuxgo_task 是按行解析的：值里带换行会把后续 pane 字段整体错位，必须在入口拒绝
  const fastify = await withFastify(t)
  const res = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/task',
    headers,
    payload: { paneId: 'local:%0', task: 'T-1\nT-2' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'AGENT_CONTROL_TASK_FAILED')
})

test('initialize advertises the fleet capabilities', async (t) => {
  const fastify = await withFastify(t)
  const res = await fastify.inject({ method: 'POST', url: '/v1/control/initialize', headers, payload: {} })
  assert.equal(res.statusCode, 200)
  const capabilities = res.json().capabilities as string[]
  assert.ok(capabilities.includes('fleet.list'), 'missing fleet.list capability')
  assert.ok(capabilities.includes('panes.task'), 'missing panes.task capability')
})
