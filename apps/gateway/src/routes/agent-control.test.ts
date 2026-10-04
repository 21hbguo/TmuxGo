import '../test-env.js'
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import test from 'node:test'
import { agentControlRoutes } from './agent-control.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import { agentControl } from '../lib/agent-control.js'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'

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
  // 新编排端点同样吃 token+env 双守卫
  for (const url of ['/v1/control/panes/snapshot', '/v1/control/panes/wait-output', '/v1/control/panes/run']) {
    const noToken = await fastify.inject({ method: 'POST', url, payload: { paneId: 'local:%1' } })
    assert.equal(noToken.statusCode, 401, url)
    const noGuard = await fastify.inject({
      method: 'POST',
      url,
      headers: { 'x-tmuxgo-agent-token': 'agent-control-secret' },
      payload: { paneId: 'local:%1' },
    })
    assert.equal(noGuard.statusCode, 403, url)
  }
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

test('agent start/prompt/cancel: auth, guard, validation and semantic envelopes', async (t) => {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  const previousAudit = process.env.TMUXGO_AUDIT_LOG
  const auditPath = `${process.env.TMUXGO_CONFIG_DIR}/task12-audit-${Date.now()}.ndjson`
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  process.env.TMUXGO_AUDIT_LOG = auditPath
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
    if (previousAudit === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAudit
    agentMonitor.stop()
  })
  const fastify = Fastify()
  await fastify.register(agentControlRoutes)
  const headers = { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' }

  for (const url of ['/v1/control/agent/start', '/v1/control/agent/prompt', '/v1/control/agent/cancel']) {
    const auth = await fastify.inject({ method: 'POST', url, payload: {} })
    assert.equal(auth.statusCode, 401, url)
    assert.equal(auth.json().code, 'AGENT_CONTROL_AUTH_REQUIRED')
    const guard = await fastify.inject({
      method: 'POST',
      url,
      headers: { 'x-tmuxgo-agent-token': 'agent-control-secret' },
      payload: {},
    })
    assert.equal(guard.statusCode, 403, url)
    assert.equal(guard.json().code, 'TMUXGO_ENV_GUARD')
  }

  // zod 拒绝 → 400 稳定码
  const badStart = await fastify.inject({ method: 'POST', url: '/v1/control/agent/start', headers, payload: {} })
  assert.equal(badStart.statusCode, 400)
  assert.equal(badStart.json().code, 'AGENT_CONTROL_START_FAILED')
  const badPrompt = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/prompt',
    headers,
    payload: { paneId: 'local:%1' },
  })
  assert.equal(badPrompt.statusCode, 400)
  assert.equal(badPrompt.json().code, 'AGENT_CONTROL_PROMPT_FAILED')
  const badCancel = await fastify.inject({ method: 'POST', url: '/v1/control/agent/cancel', headers, payload: {} })
  assert.equal(badCancel.statusCode, 400)
  assert.equal(badCancel.json().code, 'AGENT_CONTROL_CANCEL_FAILED')

  // provider 不在 allowlist → zod enum 400
  const badProvider = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/start',
    headers,
    payload: { paneId: 'local:%1', provider: 'bash' },
  })
  assert.equal(badProvider.statusCode, 400)
  assert.equal(badProvider.json().code, 'AGENT_CONTROL_START_FAILED')

  // 未注册 host → 400 START_FAILED；unknown fields 容忍
  const ghostHost = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/start',
    headers,
    payload: { paneId: 'ghost:%1', provider: 'claude', futureField: 1 },
  })
  assert.equal(ghostHost.statusCode, 400)
  assert.equal(ghostHost.json().code, 'AGENT_CONTROL_START_FAILED')

  // 不存在 pane → 409 语义码（隔离 tmux 下 PANE_MISSING；无 tmux 为 PANE_UNKNOWN）
  const missingPane = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/start',
    headers,
    payload: { paneId: 'local:%4096', provider: 'claude' },
  })
  assert.equal(missingPane.statusCode, 409)
  assert.ok(['PANE_MISSING', 'PANE_UNKNOWN'].includes(missingPane.json().code))

  const promptMissing = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/prompt',
    headers,
    payload: { paneId: 'local:%4096', prompt: 'secret-prompt-body-do-not-log' },
  })
  assert.equal(promptMissing.statusCode, 409)
  assert.ok(['PANE_MISSING', 'PANE_UNKNOWN', 'PANE_NOT_AGENT'].includes(promptMissing.json().code))

  // cancel：未知 opId → not_found（幂等 200）
  const cancel = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/cancel',
    headers,
    payload: { opId: 'never-existed' },
  })
  assert.equal(cancel.statusCode, 200)
  assert.deepEqual(cancel.json(), { ok: true, opId: 'never-existed', state: 'not_found' })
  await fastify.close()

  // 审计落盘且不含 prompt 正文
  const { readFile } = await import('node:fs/promises')
  const audit = await readFile(auditPath, 'utf8').catch(() => '')
  assert.ok(audit.includes('agent.prompt'), 'expected agent.prompt audit event')
  assert.ok(!audit.includes('secret-prompt-body-do-not-log'), 'audit must not contain prompt text')
})

for (const route of ['agent/wait', 'panes/wait-output']) {
  test(`${route} cancels when a client disconnects after sending the POST body`, { timeout: 10000 }, async (t) => {
    const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
    process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
      agentMonitor.stop()
      await killTestTmuxSession()
      if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
      else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
    })
    await killTestTmuxSession()
    const { stdout } = await execTmuxFile('tmux', [
      'new-session',
      '-d',
      '-s',
      TEST_TMUX_SESSION,
      '-P',
      '-F',
      '#{pane_id}',
      '/bin/sh',
    ])
    const paneId = `local:${stdout.trim()}`
    let rawRequest: IncomingMessage | undefined
    let rawReply: ServerResponse | undefined
    let requestAbortListeners = 0
    let responseCloseListeners = 0
    let envelope: { ok: boolean; code: string } | undefined
    fastify.addHook('preHandler', async (request, reply) => {
      rawRequest = request.raw
      rawReply = reply.raw
      requestAbortListeners = request.raw.listenerCount('aborted')
      responseCloseListeners = reply.raw.listenerCount('close')
    })
    fastify.addHook('onSend', async (_request, _reply, payload) => {
      envelope = JSON.parse(String(payload))
      return payload
    })
    await fastify.register(agentControlRoutes)
    const address = await fastify.listen({ port: 0, host: '127.0.0.1' })
    const body =
      route === 'agent/wait'
        ? { target: { paneId }, condition: { status: 'done' }, timeoutMs: 30000 }
        : { paneId, match: 'never-match-task15', timeoutMs: 30000 }
    const client = httpRequest(`${address}/v1/control/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tmuxgo-agent-token': 'agent-control-secret',
        'x-tmuxgo-env': '1',
      },
    })
    client.on('error', () => {})
    t.after(() => client.destroy())
    client.end(JSON.stringify(body))
    const startedAt = Date.now()
    while (
      !rawReply ||
      rawReply.listenerCount('close') <= responseCloseListeners ||
      (route === 'agent/wait' && agentControl.activeWaitCount() === 0)
    ) {
      assert.ok(Date.now() - startedAt < 3000, 'wait handler must start')
      await delay(10)
    }
    assert.equal(rawRequest?.complete, true)
    assert.equal(rawRequest?.aborted, false)
    client.destroy()
    while (!envelope) {
      assert.ok(Date.now() - startedAt < 4000, 'disconnect must cancel without waiting for the timeout')
      await delay(10)
    }
    assert.equal(envelope.ok, false)
    assert.equal(envelope.code, 'CLIENT_DISCONNECTED')
    assert.equal(agentControl.activeWaitCount(), 0)
    assert.equal(rawRequest?.listenerCount('aborted'), requestAbortListeners)
    assert.equal(rawReply.listenerCount('close'), responseCloseListeners)
  })
}
