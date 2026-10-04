import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import test from 'node:test'
import { authenticateHttpRequest, login } from './auth.js'
import { resolveAgentEventToken } from './agent-token.js'
import { appendAuditEvent, readAuditEvents, recordAuditRequest } from './audit-log.js'
import { getRequestPrincipal, markRequestPrincipal } from './principal.js'

function fakeRequest(headers: Record<string, unknown> = {}, principal?: unknown) {
  return { headers, principal } as never
}

test('resolves principal source: marked > agent token > anonymous', () => {
  const token = resolveAgentEventToken()
  assert.deepEqual(getRequestPrincipal(fakeRequest({ 'x-tmuxgo-agent-token': token })), {
    actor: 'agent',
    source: 'agent-token',
  })
  assert.deepEqual(getRequestPrincipal(fakeRequest({ authorization: `Bearer ${token}` })), {
    actor: 'agent',
    source: 'agent-token',
  })
  assert.deepEqual(getRequestPrincipal(fakeRequest({ 'x-tmuxgo-agent-token': 'wrong-token' })), {
    actor: 'anonymous',
    source: 'anonymous',
  })
  assert.deepEqual(getRequestPrincipal(fakeRequest()), { actor: 'anonymous', source: 'anonymous' })
  // 已标记的 http principal 优先于 agent token 头
  const marked = fakeRequest({ 'x-tmuxgo-agent-token': token }, { actor: 'admin', source: 'http', sessionId: 's1' })
  assert.equal(getRequestPrincipal(marked).actor, 'admin')
})

test('authenticates bearer and cookie tokens into an http principal', async () => {
  const { accessToken } = await login('admin', 'admin123', { ip: '127.0.0.1' })
  const bearer = fakeRequest({ authorization: `Bearer ${accessToken}` })
  const payload = authenticateHttpRequest(bearer as never)
  assert.equal(payload?.username, 'admin')
  assert.deepEqual((bearer as { principal?: unknown }).principal, {
    actor: 'admin',
    source: 'http',
    sessionId: payload?.sessionId,
  })
  const cookie = fakeRequest({ cookie: `tmuxgo_access_token=${accessToken}` })
  assert.equal(authenticateHttpRequest(cookie as never)?.username, 'admin')
  const stale = fakeRequest({ authorization: 'Bearer stale-token' })
  assert.equal(authenticateHttpRequest(stale as never), null)
  assert.equal((stale as { principal?: unknown }).principal, undefined)
})

test('records audit actor/source per principal and keeps token material out of the log', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-audit-'))
  const auditFile = path.join(dir, 'audit.ndjson')
  const previous = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_AUDIT_LOG = auditFile
  const app = Fastify()
  t.after(async () => {
    await app.close()
    if (previous === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previous
    await rm(dir, { recursive: true, force: true })
  })
  app.addHook('onSend', recordAuditRequest)
  app.post('/probe', async () => ({ ok: true }))
  app.post('/marked', async (request) => {
    markRequestPrincipal(request, { actor: 'admin', source: 'http' })
    return { ok: true }
  })
  const agentToken = resolveAgentEventToken()

  await app.inject({ method: 'POST', url: '/probe', headers: { 'x-tmuxgo-agent-token': agentToken } })
  await app.inject({ method: 'POST', url: '/probe' })
  await app.inject({
    method: 'POST',
    url: '/marked',
    headers: { cookie: 'tmuxgo_refresh_token=secret-refresh; other=1' },
    payload: { password: 'should-not-land-in-audit' },
  })

  const events = await readAuditEvents()
  const agentEvent = events.find((event) => event.source === 'agent-token')
  assert.equal(agentEvent?.actor, 'agent')
  assert.equal(agentEvent?.user, 'agent')
  const anonymousEvent = events.find((event) => event.source === 'anonymous')
  assert.equal(anonymousEvent?.actor, 'anonymous')
  const httpEvent = events.find((event) => event.source === 'http')
  assert.equal(httpEvent?.actor, 'admin')
  // 敏感材料不落盘：agent token / cookie / 密码
  const raw = await readFile(auditFile, 'utf8')
  assert.equal(raw.includes(agentToken), false)
  assert.equal(raw.includes('secret-refresh'), false)
  assert.equal(raw.includes('should-not-land-in-audit'), false)
  assert.equal(raw.includes('"user":"local"'), false)
})

test('reads legacy audit lines without actor/source fields', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-audit-legacy-'))
  const auditFile = path.join(dir, 'audit.ndjson')
  const previous = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_AUDIT_LOG = auditFile
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previous
    await rm(dir, { recursive: true, force: true })
  })
  await writeFile(
    auditFile,
    `${JSON.stringify({ id: 'old-1', timestamp: '2026-01-01T00:00:00.000Z', user: 'local', action: 'post-sessions', target: 'dev', result: 'success', method: 'POST', statusCode: 200 })}\n`,
  )
  await appendAuditEvent({
    id: 'new-1',
    timestamp: new Date().toISOString(),
    user: 'admin',
    actor: 'admin',
    source: 'http',
    action: 'post-sessions',
    target: 'dev2',
    result: 'success',
    method: 'POST',
    statusCode: 200,
  })
  const events = await readAuditEvents()
  assert.equal(events.length, 2)
  assert.equal(events[1].user, 'local')
  assert.equal(events[1].actor, undefined)
  assert.equal(events[0].actor, 'admin')
})
