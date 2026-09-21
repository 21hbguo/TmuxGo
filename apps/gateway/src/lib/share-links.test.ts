import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { getAuthGeneration } from './auth.js'
import { ShareLinkStore } from './share-links.js'

test('stores only hashed share tokens and issues single-use tickets', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-share-'))
  const filePath = path.join(configDir, 'shares.json')
  const store = new ShareLinkStore(filePath)
  const created = await store.create('local', 'shared-session', 5)
  assert.equal((await store.list())[0].id, created.id)
  const stored = await readFile(filePath, 'utf8')
  assert.equal(stored.includes(created.token), false)
  assert.equal((await stat(filePath)).mode & 0o777, 0o600)
  const exchanged = await store.exchange(created.token)
  assert.ok(exchanged)
  assert.equal('token' in exchanged, false)
  assert.equal(exchanged.link.id, created.id)
  const ticket = store.consumeTicket(exchanged.ticket)
  assert.deepEqual(ticket && { hostId: ticket.hostId, sessionName: ticket.sessionName }, {
    hostId: 'local',
    sessionName: 'shared-session',
  })
  assert.equal(store.consumeTicket(exchanged.ticket), null)
  await rm(configDir, { recursive: true, force: true })
})

test('rejects expired, revoked, and previous-auth-generation share links', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-share-invalid-'))
  const filePath = path.join(configDir, 'shares.json')
  const store = new ShareLinkStore(filePath)
  const expired = await store.create('local', 'expired-session', 5)
  const persisted = JSON.parse(await readFile(filePath, 'utf8'))
  persisted.links[0].expiresAt = new Date(Date.now() - 1000).toISOString()
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`)
  assert.equal(await new ShareLinkStore(filePath).exchange(expired.token), null)
  persisted.links[0].expiresAt = new Date(Date.now() + 60000).toISOString()
  persisted.links[0].authGeneration = getAuthGeneration() + 1
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`)
  assert.equal(await new ShareLinkStore(filePath).exchange(expired.token), null)
  persisted.links[0].authGeneration = getAuthGeneration()
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`)
  const activeStore = new ShareLinkStore(filePath)
  const exchanged = await activeStore.exchange(expired.token)
  assert.ok(exchanged)
  const ticket = activeStore.consumeTicket(exchanged.ticket)
  assert.ok(ticket)
  await activeStore.revoke(expired.id)
  assert.equal(activeStore.isTicketActive(ticket), false)
  assert.equal(await activeStore.exchange(expired.token), null)
  await rm(configDir, { recursive: true, force: true })
})
