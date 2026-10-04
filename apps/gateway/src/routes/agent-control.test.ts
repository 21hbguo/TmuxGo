import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { agentControlRoutes } from './agent-control.js'
import { agentMonitor } from '../lib/agent-monitor.js'

test('protects control routes with token and TMUXGO_ENV guard', async (t) => {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
  })
  const fastify = Fastify()
  await fastify.register(agentControlRoutes)
  const body = { paneId: 'local:%1', direction: 'horizontal' }
  const missingToken = await fastify.inject({ method: 'POST', url: '/v1/control/panes/split', payload: body })
  assert.equal(missingToken.statusCode, 401)
  const noGuard = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/split',
    headers: { 'x-tmuxgo-agent-token': 'agent-control-secret' },
    payload: body,
  })
  assert.equal(noGuard.statusCode, 403)
  const invalidWait = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/wait',
    headers: { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' },
    payload: { target: { paneId: 'local:%1' }, condition: {} },
  })
  assert.equal(invalidWait.statusCode, 400)
  await fastify.close()
})

test('control contract: stable error envelope, codes and unknown-field tolerance', async (t) => {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
  })
  const fastify = Fastify()
  await fastify.register(agentControlRoutes)
  // wait 路径会启动 agentMonitor 常驻轮询：测试结束显式 stop，否则进程不退出
  t.after(() => agentMonitor.stop())
  const headers = { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' }

  // 401/403 envelope：{message, code}，code 值是契约
  const auth = await fastify.inject({ method: 'POST', url: '/v1/control/panes/read', payload: { paneId: 'local:%0' } })
  assert.equal(auth.statusCode, 401)
  assert.equal(auth.json().code, 'AGENT_CONTROL_AUTH_REQUIRED')
  const guard = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/read',
    headers: { 'x-tmuxgo-agent-token': 'agent-control-secret' },
    payload: { paneId: 'local:%0' },
  })
  assert.equal(guard.statusCode, 403)
  assert.equal(guard.json().code, 'TMUXGO_ENV_GUARD')

  // unknown fields 被剥离容忍（v1 兼容约定）：多余字段不影响校验通过后的语义错误码
  const unknownField = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/wait',
    headers,
    payload: { target: { paneId: 'no-colon' }, condition: { status: 'done' }, unknownFutureField: { x: 1 } },
  })
  assert.equal(unknownField.statusCode, 409)
  assert.deepEqual(Object.keys(unknownField.json()).sort(), ['code', 'message', 'ok'])
  assert.equal(unknownField.json().code, 'INVALID_TARGET')
  assert.equal(unknownField.json().ok, false)

  // 校验失败 → 400 AGENT_CONTROL_WAIT_FAILED（zod 拒绝缺 target）
  const invalid = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/wait',
    headers,
    payload: { condition: { status: 'done' } },
  })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().code, 'AGENT_CONTROL_WAIT_FAILED')

  // 超时 → 409 TIMEOUT（min 250ms，空 pane 状态下必然超时）
  const timeout = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/wait',
    headers,
    payload: { target: { paneId: 'local:%4096' }, condition: { status: 'done' }, timeoutMs: 250 },
  })
  assert.equal(timeout.statusCode, 409)
  assert.equal(timeout.json().code, 'TIMEOUT')
  assert.equal(timeout.json().ok, false)
  await fastify.close()
})
