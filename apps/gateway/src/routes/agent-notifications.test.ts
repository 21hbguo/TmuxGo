import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
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

test('clear-done removes only derived-done todos, honours host scope and audits the call', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-clear-done-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const previousAuditLog = process.env.TMUXGO_AUDIT_LOG
  const auditFile = path.join(configDir, 'audit.ndjson')
  process.env.TMUXGO_CONFIG_DIR = configDir
  process.env.TMUXGO_AUDIT_LOG = auditFile
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    if (previousAuditLog === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAuditLog
    await rm(configDir, { recursive: true, force: true })
  })
  // 直接落真实 store 形状：待办分类是读时推导出来的，只有手写记录才能覆盖
  // 「老记录没有 todoState（ended/failed 也要算 done）」与「显式 pending」这两类边界
  const record = (overrides: Record<string, unknown>) => ({
    id: String(overrides.id),
    eventId: String(overrides.id),
    hostId: 'local',
    sessionName: 'dev',
    paneId: 'local:%1',
    agent: 'claude',
    status: 'done',
    message: 'claude completed a turn',
    timestamp: '2026-01-01T00:00:00.000Z',
    readBy: [],
    ...overrides,
  })
  const seeded = [
    record({ id: 'a-done', paneId: 'local:%1', status: 'done', todoState: 'done' }),
    // 没有 todoState：按 todoStateOf 推导为 done，必须一起清掉
    record({ id: 'b-ended', paneId: 'local:%2', status: 'ended' }),
    record({ id: 'c-failed', paneId: 'local:%3', status: 'failed', todoState: 'done' }),
    record({ id: 'd-blocked', paneId: 'local:%4', status: 'blocked', todoState: 'blocked' }),
    record({ id: 'e-permission', paneId: 'local:%5', status: 'permission_required' }),
    // 显式 pending：即使 status 看着像 done 也不该被清（清除条件只认推导后的 todoState）
    record({ id: 'f-pending', paneId: 'local:%6', status: 'blocked', todoState: 'pending' }),
    // 纯播报（disconnected）不进待办队列，不该被「清待办」带走
    record({ id: 'g-info', paneId: 'local:%7', status: 'disconnected' }),
    record({ id: 'h-remote-done', hostId: 'devbox', paneId: 'devbox:%1', status: 'done', todoState: 'done' }),
  ]
  await writeFile(
    path.join(configDir, 'agent-notifications.json'),
    JSON.stringify({
      version: 1,
      vapid: { subject: 'mailto:noreply@example.test', publicKey: 'pk', privateKey: 'sk' },
      subscriptions: [],
      notifications: seeded,
    }),
    { mode: 0o600 },
  )
  const fastify = Fastify()
  await fastify.register(agentNotificationRoutes)
  t.after(() => fastify.close())

  const queueBefore = await fastify.inject({ method: 'GET', url: '/agent-notifications/tasks' })
  assert.equal((queueBefore.json() as { counts: { done: number } }).counts.done, 4)

  const cleared = await fastify.inject({ method: 'POST', url: '/agent-notifications/tasks/clear-done', payload: {} })
  assert.equal(cleared.statusCode, 200)
  assert.deepEqual(cleared.json(), { ok: true, removed: 4, hosts: ['devbox', 'local'], tasksBlocked: 2 })

  const remaining = JSON.parse(await readFile(path.join(configDir, 'agent-notifications.json'), 'utf8')) as {
    notifications: { id: string }[]
  }
  assert.deepEqual(
    remaining.notifications.map((item) => item.id),
    ['d-blocked', 'e-permission', 'f-pending', 'g-info'],
  )
  const queueAfter = await fastify.inject({ method: 'GET', url: '/agent-notifications/tasks' })
  const queue = queueAfter.json() as { counts: { blocked: number; done: number } }
  assert.equal(queue.counts.done, 0)
  assert.equal(queue.counts.blocked, 2)

  // 空队列幂等：再清一次不报错、removed=0
  const again = await fastify.inject({ method: 'POST', url: '/agent-notifications/tasks/clear-done', payload: {} })
  assert.deepEqual(again.json(), { ok: true, removed: 0, hosts: [], tasksBlocked: 2 })

  // 审计是 fire-and-forget 追加，读文件要等它落盘：轮询到条数稳定为止
  const readAudit = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const events = (await readFile(auditFile, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { action: string; target: string; result: string; message?: string })
          .filter((event) => event.action === 'agent-todo-clear-done')
        if (events.length >= 2) return events
      } catch {
        // 文件还没建出来，继续等
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return [] as { action: string; target: string; result: string; message?: string }[]
  }
  const audit = await readAudit()
  // 两次调用各一条：一次成功清理、一次空队列幂等（审计照记，方便回看谁在什么时候清过）
  assert.equal(audit.length, 2)
  assert.equal(audit[0].target, '*')
  assert.equal(audit[0].result, 'success')
  assert.match(audit[0].message || '', /removed=4/)
  assert.match(audit[0].message || '', /hosts=devbox,local/)
  assert.match(audit[1].message || '', /removed=0/)
})

test('clear-done honours hostId scope and leaves other hosts untouched', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-clear-done-scope-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const previousAuditLog = process.env.TMUXGO_AUDIT_LOG
  const auditFile = path.join(configDir, 'audit.ndjson')
  process.env.TMUXGO_CONFIG_DIR = configDir
  process.env.TMUXGO_AUDIT_LOG = auditFile
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    if (previousAuditLog === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAuditLog
    await rm(configDir, { recursive: true, force: true })
  })
  const record = (overrides: Record<string, unknown>) => ({
    id: String(overrides.id),
    eventId: String(overrides.id),
    hostId: 'local',
    sessionName: 'dev',
    paneId: 'local:%1',
    agent: 'claude',
    status: 'done',
    message: 'claude completed a turn',
    timestamp: '2026-01-01T00:00:00.000Z',
    readBy: [],
    todoState: 'done',
    ...overrides,
  })
  await writeFile(
    path.join(configDir, 'agent-notifications.json'),
    JSON.stringify({
      version: 1,
      vapid: { subject: 'mailto:noreply@example.test', publicKey: 'pk', privateKey: 'sk' },
      subscriptions: [],
      notifications: [
        record({ id: 'i-local-done', paneId: 'local:%8' }),
        record({ id: 'j-remote-done', hostId: 'devbox', paneId: 'devbox:%2' }),
      ],
    }),
    { mode: 0o600 },
  )
  const fastify = Fastify()
  await fastify.register(agentNotificationRoutes)
  t.after(() => fastify.close())
  const scoped = await fastify.inject({
    method: 'POST',
    url: '/agent-notifications/tasks/clear-done',
    payload: { hostId: 'devbox' },
  })
  assert.deepEqual(scoped.json(), { ok: true, removed: 1, hosts: ['devbox'], tasksBlocked: 0 })
  const remaining = JSON.parse(await readFile(path.join(configDir, 'agent-notifications.json'), 'utf8')) as {
    notifications: { id: string }[]
  }
  assert.deepEqual(
    remaining.notifications.map((item) => item.id),
    ['i-local-done'],
  )
  let audit: { action: string; target: string; message?: string }[] = []
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      audit = (await readFile(auditFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { action: string; target: string; message?: string })
      if (audit.length) break
    } catch {
      // 等落盘
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(audit[0].action, 'agent-todo-clear-done')
  assert.equal(audit[0].target, 'devbox')
  assert.match(audit[0].message || '', /removed=1/)
})
