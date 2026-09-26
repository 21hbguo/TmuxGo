import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import test from 'node:test'
import { agentPushRoutes } from './agent-push.js'
import { inboxRoutes } from './inbox.js'
import { inboxPublicRoutes } from './inbox-public.js'
import { _resetInboxForTest } from '../lib/agent-inbox.js'

const TOKEN = 'test-agent-token'
process.env.TMUXGO_AGENT_EVENT_TOKEN = TOKEN

const headers = { 'x-tmuxgo-env': '1', 'x-tmuxgo-agent-token': TOKEN, 'content-type': 'application/json' }

async function build() {
  const fastify = Fastify()
  await fastify.register(agentPushRoutes, { prefix: '/api' })
  await fastify.register(inboxRoutes, { prefix: '/api' })
  await fastify.register(inboxPublicRoutes)
  return fastify
}

test('push requires token and env guard', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const noToken = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      payload: { type: 'text', text: 'x' },
    })
    assert.equal(noToken.statusCode, 401)
    const noEnv = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers: { 'x-tmuxgo-agent-token': TOKEN },
      payload: { type: 'text', text: 'x' },
    })
    assert.equal(noEnv.statusCode, 403)
  } finally {
    await fastify.close()
  }
})

test('text push → inbox list → mark read → delete roundtrip', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', title: 't', text: 'hello', route: { sessionName: 'dev' }, dedupeKey: 'r1' },
    })
    assert.equal(push.statusCode, 200)
    const { messageId } = push.json() as { messageId: string }
    const dup = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'again', dedupeKey: 'r1' },
    })
    assert.equal((dup.json() as { deduplicated: boolean }).deduplicated, true)
    const list = await fastify.inject({ method: 'GET', url: '/api/inbox?deviceId=d1' })
    const items = (list.json() as { messages: { id: string }[] }).messages
    assert.equal(
      items.some((m) => m.id === messageId),
      true,
    )
    const json = { 'content-type': 'application/json' }
    const read = await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/read`,
      headers: json,
      payload: { deviceId: 'd1' },
    })
    assert.equal((read.json() as { changed: number }).changed, 1)
    const del = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/delete',
      headers: json,
      payload: { ids: [messageId] },
    })
    assert.equal((del.json() as { removed: number }).removed, 1)
  } finally {
    await fastify.close()
  }
})

test('path push serves asset with Range support', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-push-route-'))
    const filePath = path.join(dir, 'clip.mp4')
    writeFileSync(filePath, Buffer.alloc(64, 7))
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'video', path: filePath, title: 'clip' },
    })
    assert.equal(push.statusCode, 200)
    const { messageId, assetId } = push.json() as { messageId: string; assetId: string }
    assert.ok(assetId)
    const full = await fastify.inject({ method: 'GET', url: `/api/inbox/${messageId}/asset` })
    assert.equal(full.statusCode, 200)
    assert.equal(full.headers['content-type'], 'video/mp4')
    const ranged = await fastify.inject({
      method: 'GET',
      url: `/api/inbox/${messageId}/asset`,
      headers: { range: 'bytes=0-9' },
    })
    assert.equal(ranged.statusCode, 206)
    assert.equal(ranged.headers['content-range'], 'bytes 0-9/64')
    assert.equal(ranged.rawPayload.length, 10)
  } finally {
    await fastify.close()
  }
})

test('sensitive path and bad link rejected', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const denied = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'file', path: `${os.homedir()}/.ssh/id_rsa` },
    })
    assert.equal(denied.statusCode, 400)
    const badLink = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'link', linkUrl: 'file:///etc/passwd' },
    })
    assert.equal(badLink.statusCode, 400)
  } finally {
    await fastify.close()
  }
})

test('open-target broadcasts without error', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/open-target',
      headers,
      payload: { route: { sessionName: 'dev', tmuxPaneId: '%2' } },
    })
    assert.equal(res.statusCode, 200)
  } finally {
    await fastify.close()
  }
})

test('control inbox query returns metadata and distinguishes delivered vs read', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const json = { 'content-type': 'application/json' }
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'receipt-check', title: 'rc' },
    })
    const { messageId } = push.json() as { messageId: string }
    // agent token 即可查询：送达 = 记录在 store；已读 = readBy 非空
    const single = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/inbox',
      headers,
      payload: { id: messageId },
    })
    assert.equal(single.statusCode, 200)
    const { message } = single.json() as { message: { id: string; readBy: string[] } }
    assert.equal(message.id, messageId)
    assert.deepEqual(message.readBy, [])
    await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/read`,
      headers: json,
      payload: { deviceId: 'd1' },
    })
    const after = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/inbox',
      headers,
      payload: { id: messageId },
    })
    assert.deepEqual((after.json() as { message: { readBy: string[] } }).message.readBy, ['d1'])
    const missing = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/inbox',
      headers,
      payload: { id: 'nope' },
    })
    assert.equal(missing.statusCode, 404)
  } finally {
    await fastify.close()
  }
})

test('share link: create → public download → list → revoke', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-share-'))
    const filePath = path.join(dir, 'report.pdf')
    writeFileSync(filePath, Buffer.from('%PDF-fake'))
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'file', path: filePath, title: 'report' },
    })
    const { messageId } = push.json() as { messageId: string }
    const badExpiry = await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/share`,
      headers: { 'content-type': 'application/json' },
      payload: { expiresInMinutes: 1 },
    })
    assert.equal(badExpiry.statusCode, 400)
    const created = await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/share`,
      headers: { 'content-type': 'application/json' },
      payload: { expiresInMinutes: 30 },
    })
    assert.equal(created.statusCode, 200)
    const { share, path: sharePath } = created.json() as { share: { id: string }; path: string }
    assert.match(sharePath, /^\/s\/i\//)
    const pub = await fastify.inject({ method: 'GET', url: sharePath })
    assert.equal(pub.statusCode, 200)
    // pdf 在 inline 白名单内，且带 sandbox CSP 兜底；svg/其他类型走 attachment
    assert.equal(pub.headers['content-security-policy'], 'sandbox')
    assert.equal(pub.headers['x-content-type-options'], 'nosniff')
    assert.match(String(pub.headers['content-disposition']), /^inline/)
    const wrong = await fastify.inject({ method: 'GET', url: `${sharePath}x` })
    assert.equal(wrong.statusCode, 404)
    const listed = await fastify.inject({ method: 'GET', url: `/api/inbox/${messageId}/shares` })
    assert.equal((listed.json() as { shares: { id: string }[] }).shares.length, 1)
    const revoked = await fastify.inject({ method: 'DELETE', url: `/api/inbox/shares/${share.id}` })
    assert.equal(revoked.statusCode, 200)
    const gone = await fastify.inject({ method: 'GET', url: sharePath })
    assert.equal(gone.statusCode, 404)
  } finally {
    await fastify.close()
  }
})
