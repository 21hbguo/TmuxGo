import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import test from 'node:test'
import { authenticateHttpRequest, consumeWebSocketTicket, isAuthEnabled, login } from '../lib/auth.js'
import { accessScopeGuard } from '../lib/access-scope.js'
import { readAuditEvents, recordAuditRequest } from '../lib/audit-log.js'
import { authRoutes } from './auth.js'
import { shareRoutes } from './shares.js'
import { hostRoutes } from './hosts.js'
import { agentControlRoutes } from './agent-control.js'

// 与 index.ts 同一形态的认证 + scope 链路（password-change 门与本任务无关，略）
const AUTH_PUBLIC = new Set([
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/shares/exchange',
  '/api/agent-events',
])
async function buildApp() {
  const app = Fastify()
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return
    const routePath = request.url.split('?')[0]
    if (!routePath.startsWith('/api/')) return
    if (AUTH_PUBLIC.has(routePath) || routePath.startsWith('/api/v1/control/')) return
    const payload = authenticateHttpRequest(request)
    if (!payload) return reply.code(401).send({ message: 'Authentication required', code: 'AUTH_REQUIRED' })
  })
  app.addHook('preHandler', accessScopeGuard)
  app.addHook('onSend', recordAuditRequest)
  await app.register(authRoutes, { prefix: '/api' })
  await app.register(shareRoutes, { prefix: '/api' })
  await app.register(hostRoutes, { prefix: '/api' })
  await app.register(agentControlRoutes, { prefix: '/api' })
  // 不触 tmux/ssh 的桩路由：只验证 scope guard 放行/拦截语义
  app.get('/api/hosts/:hostId/sessions', async () => ({ sessions: [] }))
  app.post('/api/hosts/:hostId/sessions', async () => ({ ok: true }))
  app.post('/api/hosts/:hostId/sessions/rename', async () => ({ ok: true }))
  app.post('/api/hosts/:hostId/sessions/batch-delete', async () => ({ ok: true }))
  app.get('/api/hosts/:hostId/sessions/:sessionId/layout', async () => ({ ok: true }))
  app.delete('/api/hosts/:hostId/sessions/:sessionId', async () => ({ ok: true }))
  app.post('/api/panes/select', async () => ({ ok: true }))
  app.get('/api/audit-log', async () => ({ events: [] }))
  return app
}

async function seedHosts(configDir: string) {
  const now = new Date().toISOString()
  await writeFile(
    path.join(configDir, 'hosts.json'),
    `${JSON.stringify({
      version: 2,
      hosts: [
        {
          id: 'h2',
          name: 'second-box',
          address: '10.0.0.2',
          user: 'ops',
          port: 22,
          auth: 'auto',
          groups: [],
          tags: [],
          favorite: false,
          useAgent: true,
          jumpHost: '',
          knownHostsPolicy: 'accept-new',
          tmuxPath: '',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })}\n`,
  )
}

test('host/session scope RBAC：admin 兼容、受限 token 最小权限、越权 403 不泄露', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-rbac-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const previousAgentToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  const previousAuditLog = process.env.TMUXGO_AUDIT_LOG
  const auditFile = path.join(configDir, 'audit.ndjson')
  process.env.TMUXGO_CONFIG_DIR = configDir
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'test-agent-event-token'
  process.env.TMUXGO_AUDIT_LOG = auditFile
  let app: FastifyInstance | null = null
  t.after(async () => {
    await app?.close()
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    if (previousAgentToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousAgentToken
    if (previousAuditLog === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAuditLog
    await rm(configDir, { recursive: true, force: true })
  })
  assert.equal(isAuthEnabled(), true)
  await seedHosts(configDir)
  app = await buildApp()
  const { accessToken } = await login('admin', 'admin123', { ip: '127.0.0.1' })
  const asAdmin = { authorization: `Bearer ${accessToken}` }
  const denied = { message: 'Forbidden', code: 'SCOPE_DENIED' }

  // 基线：admin 全权不变
  let res = await app.inject({ method: 'GET', url: '/api/hosts', headers: asAdmin })
  assert.equal(res.statusCode, 200)
  assert.equal(
    (res.json() as { id: string }[]).some((host) => host.id === 'h2'),
    true,
  )
  res = await app.inject({
    method: 'POST',
    url: '/api/hosts/local/sessions',
    headers: asAdmin,
    payload: { name: 's1' },
  })
  assert.equal(res.statusCode, 200)
  res = await app.inject({ method: 'GET', url: '/api/audit-log', headers: asAdmin })
  assert.equal(res.statusCode, 200)

  // 受限 token：hosts=[local]
  res = await app.inject({
    method: 'POST',
    url: '/api/auth/tokens',
    headers: asAdmin,
    payload: { name: 'viewer', scope: { hosts: ['local'] } },
  })
  assert.equal(res.statusCode, 200)
  const viewer = (res.json() as { token: string }).token
  const asViewer = { authorization: `Bearer ${viewer}` }

  // GET 列表不泄露未授权 host
  res = await app.inject({ method: 'GET', url: '/api/hosts', headers: asViewer })
  assert.equal(res.statusCode, 200)
  assert.deepEqual((res.json() as { id: string }[]).map((host) => host.id).sort(), ['local'])
  // 存在与不存在的 host 返回同一 403 文案，不区分资源存在性
  res = await app.inject({ method: 'GET', url: '/api/hosts/h2', headers: asViewer })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), denied)
  res = await app.inject({ method: 'GET', url: '/api/hosts/ghost', headers: asViewer })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), denied)
  // GET /sessions 同样受限
  res = await app.inject({ method: 'GET', url: '/api/hosts/h2/sessions', headers: asViewer })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), denied)
  res = await app.inject({ method: 'GET', url: '/api/hosts/local/sessions', headers: asViewer })
  assert.equal(res.statusCode, 200)
  // 写操作按 host 边界判定
  res = await app.inject({
    method: 'POST',
    url: '/api/hosts/local/sessions',
    headers: asViewer,
    payload: { name: 's1' },
  })
  assert.equal(res.statusCode, 200)
  res = await app.inject({ method: 'POST', url: '/api/hosts/h2/sessions', headers: asViewer, payload: { name: 's1' } })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), denied)
  // pane 目标经 body.paneId 携带 host 前缀，同样拦截
  res = await app.inject({ method: 'POST', url: '/api/panes/select', headers: asViewer, payload: { paneId: 'h2:%1' } })
  assert.equal(res.statusCode, 403)
  res = await app.inject({
    method: 'POST',
    url: '/api/panes/select',
    headers: asViewer,
    payload: { paneId: 'local:%1' },
  })
  assert.equal(res.statusCode, 200)
  // 实例管理面对受限身份关闭
  for (const [method, url] of [
    ['GET', '/api/audit-log'],
    ['POST', '/api/hosts'],
    ['DELETE', '/api/hosts/h2'],
    ['GET', '/api/hosts/config'],
    ['POST', '/api/shares'],
    ['GET', '/api/auth/tokens'],
  ] as const) {
    res = await app.inject({ method, url, headers: asViewer, payload: method === 'GET' ? undefined : {} })
    assert.equal(res.statusCode, 403, `${method} ${url}`)
    assert.deepEqual(res.json(), denied)
  }
  // ws-ticket：scoped token 换到的票据携带同一 scope（WS/HTTP 身份一致）
  res = await app.inject({ method: 'POST', url: '/api/auth/ws-ticket', headers: asViewer })
  assert.equal(res.statusCode, 200)
  const ticket = (res.json() as { ticket: string }).ticket
  const wsUser = consumeWebSocketTicket(ticket)
  assert.equal(wsUser?.username, 'token:viewer')
  assert.deepEqual(wsUser?.scope, { hosts: ['local'] })

  // readOnly token：GET 放行、写操作 403
  res = await app.inject({
    method: 'POST',
    url: '/api/auth/tokens',
    headers: asAdmin,
    payload: { name: 'ro', scope: { hosts: ['local'], readOnly: true } },
  })
  const roToken = (res.json() as { token: string }).token
  const asRo = { authorization: `Bearer ${roToken}` }
  res = await app.inject({ method: 'GET', url: '/api/hosts/local/sessions', headers: asRo })
  assert.equal(res.statusCode, 200)
  res = await app.inject({ method: 'POST', url: '/api/hosts/local/sessions', headers: asRo, payload: { name: 's1' } })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), denied)

  // session 白名单：s1 放行、s2 拦截（含 rename/create 的新名）
  res = await app.inject({
    method: 'POST',
    url: '/api/auth/tokens',
    headers: asAdmin,
    payload: { name: 's1-only', scope: { hosts: ['local'], sessions: ['s1'] } },
  })
  const s1Token = (res.json() as { token: string }).token
  const asS1 = { authorization: `Bearer ${s1Token}` }
  res = await app.inject({
    method: 'DELETE',
    url: '/api/hosts/local/sessions/session-local-s1',
    headers: asS1,
  })
  assert.equal(res.statusCode, 200)
  res = await app.inject({
    method: 'DELETE',
    url: '/api/hosts/local/sessions/session-local-s2',
    headers: asS1,
  })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), denied)
  res = await app.inject({
    method: 'POST',
    url: '/api/hosts/local/sessions/rename',
    headers: asS1,
    payload: { sessionId: 'session-local-s2', name: 's2b' },
  })
  assert.equal(res.statusCode, 403)
  res = await app.inject({
    method: 'POST',
    url: '/api/hosts/local/sessions',
    headers: asS1,
    payload: { name: 's2' },
  })
  assert.equal(res.statusCode, 403)
  res = await app.inject({
    method: 'POST',
    url: '/api/hosts/local/sessions/batch-delete',
    headers: asS1,
    payload: { sessionIds: ['session-local-s1', 'session-local-s2'] },
  })
  assert.equal(res.statusCode, 403)

  // token 撤销 → 401；token 原文不进审计
  const tokens = await app.inject({ method: 'GET', url: '/api/auth/tokens', headers: asAdmin })
  const viewerId = (tokens.json() as { tokens: { id: string; name: string }[] }).tokens.find(
    (token) => token.name === 'viewer',
  )!.id
  res = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${viewerId}`, headers: asAdmin })
  assert.equal(res.statusCode, 200)
  res = await app.inject({ method: 'GET', url: '/api/hosts/local/sessions', headers: asViewer })
  assert.equal(res.statusCode, 401)

  // 登录用户 scope 覆盖：subjects["user:admin"] 生效后可逆
  const scopeFile = path.join(configDir, 'access-scopes.json')
  const stored = JSON.parse(await readFile(scopeFile, 'utf8')) as Record<string, unknown>
  await writeFile(scopeFile, `${JSON.stringify({ ...stored, subjects: { 'user:admin': { hosts: ['local'] } } })}\n`)
  res = await app.inject({ method: 'GET', url: '/api/hosts/h2/sessions', headers: asAdmin })
  assert.equal(res.statusCode, 403)
  res = await app.inject({ method: 'GET', url: '/api/hosts/local/sessions', headers: asAdmin })
  assert.equal(res.statusCode, 200)
  await writeFile(scopeFile, `${JSON.stringify({ ...stored, subjects: {} })}\n`)
  res = await app.inject({ method: 'GET', url: '/api/hosts/h2/sessions', headers: asAdmin })
  assert.equal(res.statusCode, 200)

  // agent token 最小权限：subjects.agent 限制后跨 host 控制面调用 403
  // （allow 侧用未注册 host——快速失败且不等于 403 即证明未被 scope 拦截）
  const agentHeaders = { 'x-tmuxgo-agent-token': 'test-agent-event-token', 'x-tmuxgo-env': '1' }
  res = await app.inject({
    method: 'POST',
    url: '/api/v1/control/panes/read',
    headers: agentHeaders,
    payload: { paneId: 'missing:%1', lines: 10 },
  })
  assert.notEqual(res.statusCode, 403)
  await writeFile(scopeFile, `${JSON.stringify({ ...stored, subjects: { agent: { hosts: ['local'] } } })}\n`)
  res = await app.inject({
    method: 'POST',
    url: '/api/v1/control/panes/read',
    headers: agentHeaders,
    payload: { paneId: 'h2:%1', lines: 10 },
  })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), denied)
  res = await app.inject({
    method: 'POST',
    url: '/api/v1/control/panes/read',
    headers: agentHeaders,
    payload: { paneId: 'local:%1', lines: 10 },
  })
  assert.notEqual(res.statusCode, 403)
  await writeFile(scopeFile, `${JSON.stringify({ ...stored, subjects: {} })}\n`)

  // 审计：deny 决策留痕 actor/source/host/scope，token 原文不落盘
  const events = await readAuditEvents({ limit: 1000 })
  const denies = events.filter((event) => event.action === 'scope.deny')
  assert.ok(denies.length >= 10)
  assert.ok(denies.every((event) => event.actor && event.source))
  assert.ok(denies.some((event) => event.actor === 'token:viewer' && event.hostId === 'h2'))
  const rawAudit = await readFile(auditFile, 'utf8')
  assert.equal(rawAudit.includes(viewer), false)
  assert.equal(rawAudit.includes('test-agent-event-token'), false)
  assert.ok(
    events.some((event) => event.scope && event.actor === 'token:viewer'),
    'scoped principal requests carry scope summary in audit',
  )
})

test('auth disabled 模式（本机/内网部署）不触发 scope 拦截——回归', async (t) => {
  const app = Fastify()
  t.after(() => app.close())
  app.addHook('preHandler', accessScopeGuard)
  app.get('/api/audit-log', async () => ({ events: [] }))
  app.post('/api/panes/select', async () => ({ ok: true }))
  // 无认证环境 principal=anonymous、无 scope：行为与旧版一致
  let res = await app.inject({ method: 'GET', url: '/api/audit-log' })
  assert.equal(res.statusCode, 200)
  res = await app.inject({ method: 'POST', url: '/api/panes/select', payload: { paneId: 'any:%1' } })
  assert.equal(res.statusCode, 200)
})
