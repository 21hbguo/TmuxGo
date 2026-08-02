import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'

test('auth persists independent sessions and rotates refresh tokens', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-auth-'))
  process.env.TMUXGO_AUTH_USERNAME = 'test-user'
  process.env.TMUXGO_AUTH_PASSWORD = 'test-password'
  process.env.TMUXGO_CONFIG_DIR = configDir
  const auth = await import(`./auth.js?test=${Date.now()}`)
  const first = await auth.login('test-user', 'test-password', { ip: 'one' })
  const second = await auth.login('test-user', 'test-password', { ip: 'two' })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.ok(auth.verifyAccessToken(first.accessToken))
  const rotated = await auth.refresh(first.refreshToken)
  assert.notEqual(rotated.refreshToken, first.refreshToken)
  assert.equal(await auth.refresh(first.refreshToken).catch(() => null), null)
  assert.equal((await auth.listSessions()).length, 2)
  const ticket = await auth.issueWebSocketTicket(rotated.accessToken)
  assert.deepEqual(auth.consumeWebSocketTicket(ticket.ticket), { username: 'test-user' })
  assert.equal(auth.consumeWebSocketTicket(ticket.ticket), null)
  const revokedTicket = await auth.issueWebSocketTicket(second.accessToken)
  await auth.logout(second.refreshToken)
  assert.equal(auth.consumeWebSocketTicket(revokedTicket.ticket), null)
  const persisted = JSON.parse(await readFile(path.join(configDir, 'auth.json'), 'utf8'))
  assert.equal(typeof persisted.passwordHash, 'string')
  assert.equal(typeof persisted.signingKey, 'string')
  assert.equal(persisted.sessions.every((session: { refreshTokenHash?: string }) => typeof session.refreshTokenHash === 'string'), true)
  await rm(configDir, { recursive: true, force: true })
})

test('auth requires changing the default password and invalidates every credential', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-auth-default-'))
  process.env.TMUXGO_AUTH_USERNAME = 'admin'
  process.env.TMUXGO_AUTH_PASSWORD = 'admin123'
  process.env.TMUXGO_CONFIG_DIR = configDir
  const auth = await import(`./auth.js?default-test=${Date.now()}-${Math.random()}`)
  await auth.initializeAuthStore()
  assert.equal(auth.isPasswordChangeRequired(), true)
  const first = await auth.login('admin', 'admin123', { ip: 'one' })
  const second = await auth.login('admin', 'admin123', { ip: 'two' })
  assert.equal(first.passwordChangeRequired, true)
  assert.equal(await auth.deleteOtherSessions(first.sessionId), 1)
  assert.ok(auth.verifyAccessToken(first.accessToken))
  assert.equal(auth.verifyAccessToken(second.accessToken), null)
  const ticket = await auth.issueWebSocketTicket(first.accessToken)
  await auth.changePassword('admin123', 'changed-password')
  assert.equal(auth.isPasswordChangeRequired(), false)
  assert.equal(auth.verifyAccessToken(first.accessToken), null)
  assert.equal(await auth.refresh(first.refreshToken).catch(() => null), null)
  assert.equal(auth.consumeWebSocketTicket(ticket.ticket), null)
  await assert.rejects(auth.changePassword('changed-password', 'admin123'), { code: 'DEFAULT_PASSWORD_NOT_ALLOWED' })
  await rm(configDir, { recursive: true, force: true })
})
