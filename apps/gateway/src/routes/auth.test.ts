import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import test from 'node:test'
import { readAuditEvents, recordAuditRequest } from '../lib/audit-log.js'

test('rejects anonymous session revocation and records authentication audit events', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-auth-route-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const previousUsername = process.env.TMUXGO_AUTH_USERNAME
  const previousPassword = process.env.TMUXGO_AUTH_PASSWORD
  const previousAuditLog = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_CONFIG_DIR = configDir
  process.env.TMUXGO_AUTH_USERNAME = 'test-user'
  process.env.TMUXGO_AUTH_PASSWORD = 'test-password'
  process.env.TMUXGO_AUDIT_LOG = path.join(configDir, 'audit.ndjson')
  const app = Fastify()
  t.after(async () => {
    await app.close()
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    if (previousUsername === undefined) delete process.env.TMUXGO_AUTH_USERNAME
    else process.env.TMUXGO_AUTH_USERNAME = previousUsername
    if (previousPassword === undefined) delete process.env.TMUXGO_AUTH_PASSWORD
    else process.env.TMUXGO_AUTH_PASSWORD = previousPassword
    if (previousAuditLog === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAuditLog
    await rm(configDir, { recursive: true, force: true })
  })
  const { authRoutes } = await import(`./auth.js?test=${Date.now()}-${Math.random()}`)
  app.addHook('onSend', recordAuditRequest)
  await app.register(authRoutes, { prefix: '/api' })
  const failedLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'test-user', password: 'wrong-password' } })
  assert.equal(failedLogin.statusCode, 401)
  const firstLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'test-user', password: 'test-password' } })
  assert.equal(firstLogin.statusCode, 200)
  const first = firstLogin.json() as { accessToken: string; sessionId: string }
  await t.test('issues a WebSocket ticket with a valid access cookie when Bearer is stale', async () => {
    const ticket = await app.inject({ method: 'POST', url: '/api/auth/ws-ticket', headers: { authorization: 'Bearer stale-token', cookie: `tmuxgo_access_token=${first.accessToken}` } })
    assert.equal(ticket.statusCode, 200)
    assert.equal(typeof (ticket.json() as { ticket?: unknown }).ticket, 'string')
  })
  const anonymousLogout = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { sessionId: first.sessionId } })
  assert.equal(anonymousLogout.statusCode, 401)
  const sessions = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { authorization: `Bearer ${first.accessToken}` } })
  assert.equal(sessions.statusCode, 200)
  assert.equal((sessions.json() as { sessions: { id: string }[] }).sessions.some((session) => session.id === first.sessionId), true)
  const secondLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'test-user', password: 'test-password' } })
  const second = secondLogin.json() as { sessionId: string }
  const revoked = await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${second.sessionId}`, headers: { authorization: `Bearer ${first.accessToken}` } })
  assert.equal(revoked.statusCode, 200)
  const thirdLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'test-user', password: 'test-password' } })
  assert.equal(thirdLogin.statusCode, 200)
  const revokeOthers = await app.inject({ method: 'POST', url: '/api/auth/sessions/revoke-others', headers: { authorization: `Bearer ${first.accessToken}` } })
  assert.equal(revokeOthers.statusCode, 200)
  const changed = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: { authorization: `Bearer ${first.accessToken}` }, payload: { currentPassword: 'test-password', newPassword: 'changed-password' } })
  assert.equal(changed.statusCode, 200)
  const events = await readAuditEvents()
  assert.equal(events.some((event) => event.action === 'post-auth-login' && event.result === 'failure'), true)
  assert.equal(events.some((event) => event.action === 'delete-auth-sessions' && event.result === 'success'), true)
  assert.equal(events.some((event) => event.action === 'post-auth-sessions-revoke-others' && event.result === 'success'), true)
  assert.equal(events.some((event) => event.action === 'post-auth-change-password' && event.result === 'success'), true)
  assert.equal(events.some((event) => event.target.includes('test-password') || event.target.includes('wrong-password') || event.target.includes('changed-password')), false)
})
