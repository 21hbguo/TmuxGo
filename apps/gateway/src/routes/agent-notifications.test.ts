import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import test from 'node:test'
import { persistAgentNotification } from '../lib/agent-notifications.js'
import { agentNotificationRoutes } from './agent-notifications.js'

test('persists VAPID keys and synchronizes unread notifications across devices', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-agent-notifications-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  const fastify = Fastify()
  await fastify.register(agentNotificationRoutes)
  const firstKey = await fastify.inject({ method: 'GET', url: '/agent-notifications/vapid-public-key' })
  assert.equal(firstKey.statusCode, 200)
  const publicKey = (firstKey.json() as { publicKey: string }).publicKey
  assert.ok(publicKey.length > 20)
  const secondKey = await fastify.inject({ method: 'GET', url: '/agent-notifications/vapid-public-key' })
  assert.equal((secondKey.json() as { publicKey: string }).publicKey, publicKey)
  const persistedPath = path.join(configDir, 'agent-notifications.json')
  assert.equal((await stat(persistedPath)).mode & 0o777, 0o600)
  const notification = await persistAgentNotification({
    type: 'agent_notification',
    hostId: 'local',
    sessionName: 'dev',
    eventId: 'event-1',
    pane: {
      paneId: 'local:%1',
      tmuxPaneId: '%1',
      sessionName: 'dev',
      agent: 'codex',
      agentStatus: 'blocked',
      phase: 'permission_required',
      lastEvent: 'permission_required',
      revision: 1,
    },
  })
  assert.equal(notification?.status, 'permission_required')
  const unreadDeviceOne = await fastify.inject({
    method: 'GET',
    url: '/agent-notifications/unread?deviceId=device-one',
  })
  assert.equal(unreadDeviceOne.statusCode, 200)
  assert.equal((unreadDeviceOne.json() as { notifications: { id: string }[] }).notifications[0]?.id, 'event-1')
  const marked = await fastify.inject({
    method: 'POST',
    url: '/agent-notifications/read',
    payload: { deviceId: 'device-one', ids: ['event-1'] },
  })
  assert.equal(marked.statusCode, 200)
  assert.equal((marked.json() as { changed: number }).changed, 1)
  const readDeviceOne = await fastify.inject({ method: 'GET', url: '/agent-notifications/unread?deviceId=device-one' })
  assert.deepEqual((readDeviceOne.json() as { notifications: unknown[] }).notifications, [])
  const unreadDeviceTwo = await fastify.inject({
    method: 'GET',
    url: '/agent-notifications/unread?deviceId=device-two',
  })
  assert.equal((unreadDeviceTwo.json() as { notifications: { id: string }[] }).notifications[0]?.id, 'event-1')
  const mismatch = await fastify.inject({
    method: 'GET',
    url: '/agent-notifications/unread?deviceId=device-one',
    headers: { 'x-tmuxgo-device-id': 'device-two' },
  })
  assert.equal(mismatch.statusCode, 400)
  const invalidSubscription = await fastify.inject({
    method: 'POST',
    url: '/agent-notifications/subscriptions',
    payload: {
      deviceId: 'device-one',
      subscription: { endpoint: 'http://not-secure.example', keys: { p256dh: 'key', auth: 'auth' } },
    },
  })
  assert.equal(invalidSubscription.statusCode, 400)
  const registered = await fastify.inject({
    method: 'POST',
    url: '/agent-notifications/subscriptions',
    payload: {
      deviceId: 'device-one',
      subscription: { endpoint: 'https://push.example.test/subscription-1', keys: { p256dh: 'key', auth: 'auth' } },
    },
  })
  assert.equal(registered.statusCode, 200)
  const subscriptionId = (registered.json() as { id: string }).id
  const revoked = await fastify.inject({
    method: 'DELETE',
    url: `/agent-notifications/subscriptions/${subscriptionId}?deviceId=device-one`,
  })
  assert.deepEqual(revoked.json(), { revoked: true })
  const file = JSON.parse(await readFile(persistedPath, 'utf8')) as { subscriptions: unknown[] }
  assert.equal(file.subscriptions.length, 0)
  await fastify.close()
})
