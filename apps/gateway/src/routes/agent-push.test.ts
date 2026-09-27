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
import { _resetInboxForTest, subscribeInbox, type InboxEvent } from '../lib/agent-inbox.js'

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

test('list keeps read history; unread=1 is an explicit filter', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const json = { 'content-type': 'application/json' }
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'history' },
    })
    const { messageId } = push.json() as { messageId: string }
    const before = await fastify.inject({ method: 'GET', url: '/api/inbox?deviceId=d1' })
    assert.equal((before.json() as { unreadCount: number }).unreadCount, 1)
    await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/read`,
      headers: json,
      payload: { deviceId: 'd1' },
    })
    // 修复点：deviceId 不再把列表过滤成仅未读——已读消息必须留在历史
    const after = await fastify.inject({ method: 'GET', url: '/api/inbox?deviceId=d1' })
    const afterJson = after.json() as { messages: { id: string; readAt?: string }[]; unreadCount: number }
    assert.equal(
      afterJson.messages.some((m) => m.id === messageId),
      true,
    )
    assert.equal(afterJson.unreadCount, 0)
    assert.ok(afterJson.messages.find((m) => m.id === messageId)?.readAt)
    // 显式 unread=1 才过滤
    const unread = await fastify.inject({ method: 'GET', url: '/api/inbox?deviceId=d1&unread=1' })
    assert.equal((unread.json() as { messages: unknown[] }).messages.length, 0)
  } finally {
    await fastify.close()
  }
})

test('revision is monotonic and events carry rev + batch payload', async () => {
  _resetInboxForTest()
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  const fastify = await build()
  try {
    const json = { 'content-type': 'application/json' }
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'rev-check' },
    })
    const { messageId, revision } = push.json() as { messageId: string; revision: number }
    assert.ok(revision > 0)
    const read = await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/read`,
      headers: json,
      payload: { deviceId: 'd1' },
    })
    const readJson = read.json() as { changed: number; revision: number }
    assert.equal(readJson.changed, 1)
    assert.ok(readJson.revision > revision)
    const del = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/delete',
      headers: json,
      payload: { ids: [messageId] },
    })
    assert.ok((del.json() as { revision: number }).revision > readJson.revision)
    // 软删走 updated 事件（带 deletedAt）；回收站视图可见
    const trash = await fastify.inject({ method: 'GET', url: '/api/inbox?view=trash' })
    assert.equal(
      (trash.json() as { messages: { id: string }[] }).messages.some((m) => m.id === messageId),
      true,
    )
    const purge = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/purge',
      headers: json,
      payload: { ids: [messageId] },
    })
    assert.ok((purge.json() as { revision: number }).revision > (del.json() as { revision: number }).revision)
    const created = events.find((e) => e.type === 'inbox_message_created')
    const updated = events.find((e) => e.type === 'inbox_message_updated')
    const deleted = events.find((e) => e.type === 'inbox_message_deleted')
    assert.ok(created && 'rev' in created && created.rev === revision)
    assert.ok(updated && 'messages' in updated && updated.messages.some((m) => m.id === messageId))
    assert.ok(
      deleted && 'ids' in deleted && deleted.ids.includes(messageId) && deleted.rev > (updated as { rev: number }).rev,
    )
  } finally {
    unsubscribe()
    await fastify.close()
  }
})

test('archive endpoint closes read, keeps history, refuses unread', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const json = { 'content-type': 'application/json' }
    const pushA = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'read me' },
    })
    const pushB = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'unread one' },
    })
    const a = (pushA.json() as { messageId: string }).messageId
    const b = (pushB.json() as { messageId: string }).messageId
    await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${a}/read`,
      headers: json,
      payload: { deviceId: 'd1' },
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/archive',
      headers: json,
      payload: { ids: [a, b] },
    })
    const body = res.json() as { changed: number; skippedUnread: number; revision: number }
    assert.equal(body.changed, 1)
    assert.equal(body.skippedUnread, 1)
    // 默认视图只显示活动的；归档的在 archived=1 / archived=all
    const active = await fastify.inject({ method: 'GET', url: '/api/inbox' })
    assert.deepEqual(
      (active.json() as { messages: { id: string }[] }).messages.map((m) => m.id),
      [b],
    )
    const arch = await fastify.inject({ method: 'GET', url: '/api/inbox?archived=1' })
    assert.deepEqual(
      (arch.json() as { messages: { id: string; archivedAt?: string }[] }).messages.map((m) => m.id),
      [a],
    )
    const all = await fastify.inject({ method: 'GET', url: '/api/inbox?archived=all' })
    assert.equal((all.json() as { messages: unknown[] }).messages.length, 2)
    // 恢复
    const un = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/archive',
      headers: json,
      payload: { ids: [a], archived: false },
    })
    assert.equal((un.json() as { changed: number }).changed, 1)
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

test('trash lifecycle via routes: delete → trash view → restore → purge', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const json = { 'content-type': 'application/json' }
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'route-trash' },
    })
    const { messageId } = push.json() as { messageId: string }
    // 删除=进回收站：活动视图消失，view=trash 可见，view=all 保留
    await fastify.inject({
      method: 'POST',
      url: '/api/inbox/delete',
      headers: json,
      payload: { ids: [messageId] },
    })
    const active = (await fastify.inject({ method: 'GET', url: '/api/inbox' })).json() as {
      messages: { id: string }[]
      stats: { messages: number; assetBytes: number }
    }
    assert.equal(
      active.messages.some((m) => m.id === messageId),
      false,
    )
    assert.equal(active.stats.messages, 0)
    const trash = (await fastify.inject({ method: 'GET', url: '/api/inbox?view=trash' })).json() as {
      messages: { id: string; deletedAt?: string }[]
    }
    assert.ok(trash.messages.find((m) => m.id === messageId)?.deletedAt)
    const all = (await fastify.inject({ method: 'GET', url: '/api/inbox?view=all' })).json() as {
      messages: { id: string }[]
    }
    assert.equal(all.messages.length, 1)
    // 恢复：回活动视图
    const restored = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/restore',
      headers: json,
      payload: { ids: [messageId] },
    })
    assert.equal((restored.json() as { restored: number }).restored, 1)
    const activeAfter = (await fastify.inject({ method: 'GET', url: '/api/inbox' })).json() as {
      messages: { id: string }[]
    }
    assert.equal(
      activeAfter.messages.some((m) => m.id === messageId),
      true,
    )
    // 活动消息不能被 purge；进回收站后才能物理删除
    const purgeActive = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/purge',
      headers: json,
      payload: { ids: [messageId] },
    })
    assert.equal((purgeActive.json() as { purged: number }).purged, 0)
    await fastify.inject({
      method: 'POST',
      url: '/api/inbox/delete',
      headers: json,
      payload: { ids: [messageId] },
    })
    const purged = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/purge',
      headers: json,
      payload: { ids: [messageId] },
    })
    assert.equal((purged.json() as { purged: number }).purged, 1)
    const finalAll = (await fastify.inject({ method: 'GET', url: '/api/inbox?view=all' })).json() as {
      messages: unknown[]
    }
    assert.equal(finalAll.messages.length, 0)
  } finally {
    await fastify.close()
  }
})

test('read=false marks messages unread again via batch and single routes', async () => {
  _resetInboxForTest()
  const fastify = await build()
  try {
    const json = { 'content-type': 'application/json' }
    const push = await fastify.inject({
      method: 'POST',
      url: '/api/v1/control/push',
      headers,
      payload: { type: 'text', text: 'flip-flop' },
    })
    const { messageId } = push.json() as { messageId: string }
    const batch = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/read',
      headers: json,
      payload: { ids: [messageId], deviceId: 'd1' },
    })
    assert.equal((batch.json() as { changed: number }).changed, 1)
    const unreadBatch = await fastify.inject({
      method: 'POST',
      url: '/api/inbox/read',
      headers: json,
      payload: { ids: [messageId], deviceId: 'd1', read: false },
    })
    assert.equal((unreadBatch.json() as { changed: number }).changed, 1)
    const unread = (await fastify.inject({ method: 'GET', url: '/api/inbox?deviceId=d1' })).json() as {
      unreadCount: number
    }
    assert.equal(unread.unreadCount, 1)
    // 单条路由同样支持 read:false
    await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/read`,
      headers: json,
      payload: { deviceId: 'd1' },
    })
    const unSingle = await fastify.inject({
      method: 'POST',
      url: `/api/inbox/${messageId}/read`,
      headers: json,
      payload: { deviceId: 'd1', read: false },
    })
    assert.equal((unSingle.json() as { changed: number }).changed, 1)
    const again = (await fastify.inject({ method: 'GET', url: '/api/inbox?deviceId=d1' })).json() as {
      unreadCount: number
    }
    assert.equal(again.unreadCount, 1)
  } finally {
    await fastify.close()
  }
})
