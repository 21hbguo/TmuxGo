import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { agentControlRoutes } from './agent-control.js'
import { CONTROL_CAPABILITIES, CONTROL_ERROR_CODES } from '../lib/control-protocol.js'

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

test('initialize negotiates protocol version and capabilities', async (t) => {
  const fastify = await withFastify(t)

  // 双守卫不豁免
  const noToken = await fastify.inject({ method: 'POST', url: '/v1/control/initialize', payload: {} })
  assert.equal(noToken.statusCode, 401)
  const noGuard = await fastify.inject({
    method: 'POST',
    url: '/v1/control/initialize',
    headers: { 'x-tmuxgo-agent-token': 'agent-control-secret' },
    payload: {},
  })
  assert.equal(noGuard.statusCode, 403)

  // 旧客户端不带版本 → 默认 v1 兼容
  const legacy = await fastify.inject({ method: 'POST', url: '/v1/control/initialize', headers, payload: {} })
  assert.equal(legacy.statusCode, 200)
  assert.deepEqual(legacy.json(), {
    ok: true,
    protocolVersion: 'v1',
    supportedVersions: ['v1'],
    capabilities: [...CONTROL_CAPABILITIES],
  })
  assert.equal(legacy.headers['cache-control'], 'no-store')

  // 显式 v1 → 协商成功；未知字段剥离容忍
  const v1 = await fastify.inject({
    method: 'POST',
    url: '/v1/control/initialize',
    headers,
    payload: { protocolVersion: 'v1', futureField: 1 },
  })
  assert.equal(v1.statusCode, 200)
  assert.equal(v1.json().protocolVersion, 'v1')

  // 未知版本 → 400 明确协商错误，附支持列表
  const unknown = await fastify.inject({
    method: 'POST',
    url: '/v1/control/initialize',
    headers,
    payload: { protocolVersion: 'v99' },
  })
  assert.equal(unknown.statusCode, 400)
  assert.equal(unknown.json().code, 'UNSUPPORTED_PROTOCOL_VERSION')
  assert.deepEqual(unknown.json().supportedVersions, ['v1'])

  // body 校验失败 → 通用 initialize 失败码
  const invalid = await fastify.inject({
    method: 'POST',
    url: '/v1/control/initialize',
    headers,
    payload: { protocolVersion: 42 },
  })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().code, 'AGENT_CONTROL_INITIALIZE_FAILED')
})

test('GET /v1/control/schema serves the versioned protocol document', async (t) => {
  const fastify = await withFastify(t)

  const noToken = await fastify.inject({ method: 'GET', url: '/v1/control/schema' })
  assert.equal(noToken.statusCode, 401)

  const res = await fastify.inject({ method: 'GET', url: '/v1/control/schema', headers })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const doc = res.json()
  assert.equal(doc.protocolVersion, 'v1')
  assert.deepEqual(doc.supportedVersions, ['v1'])
  assert.equal(doc.basePath, '/api/v1/control')

  // 全部方法（含 Task9 编排与 Task12 agent actions）都在文档里
  for (const name of CONTROL_CAPABILITIES) {
    assert.ok(doc.methods[name], `schema missing method ${name}`)
  }
  // 每个方法的 params/result/errors 齐全；错误码表与契约一致
  assert.deepEqual(doc.errorCodes, [...CONTROL_ERROR_CODES])
  for (const [name, method] of Object.entries(
    doc.methods as Record<string, { http: string; path: string; result: unknown; errors: string[] }>,
  )) {
    assert.ok(method.http && method.path, `${name} missing http/path`)
    assert.ok(method.result, `${name} missing result schema`)
    assert.ok(method.errors.includes('AGENT_CONTROL_AUTH_REQUIRED'), `${name} missing auth error`)
    assert.ok(method.errors.includes('TMUXGO_ENV_GUARD'), `${name} missing guard error`)
    for (const code of method.errors)
      assert.ok((CONTROL_ERROR_CODES as readonly string[]).includes(code), `${name}: unknown code ${code}`)
  }

  // 文档不得夹带 token 值 / 环境变量名 / 终端输出样例
  // （TMUXGO_ENV_GUARD 是契约错误码名而非环境变量，剔除后再扫）
  const text = JSON.stringify(doc).replaceAll('TMUXGO_ENV_GUARD', '')
  assert.ok(!/TMUXGO_[A-Z_]+/.test(text), 'schema must not embed env var names')
  assert.ok(!/agent-event-token|Bearer [A-Za-z0-9]/i.test(text), 'schema must not embed token material')
})
