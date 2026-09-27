import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  archiveInboxMessages,
  createPush,
  deleteInboxMessages,
  getInboxAsset,
  isSensitivePath,
  listInboxMessages,
  markInboxRead,
  purgeInboxMessages,
  restoreInboxMessages,
  sanitizeFileName,
  subscribeInbox,
  _resetInboxForTest,
  type InboxEvent,
} from './agent-inbox.js'

test('push text message emits inbox_message_created and persists', async () => {
  _resetInboxForTest()
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  const { message } = await createPush({
    type: 'text',
    text: 'hello inbox',
    title: 't1',
    route: { sessionName: 'dev' },
  })
  assert.equal(message.type, 'text')
  assert.equal(message.text, 'hello inbox')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'inbox_message_created')
  const list = await listInboxMessages()
  assert.equal(
    list.messages.some((m) => m.id === message.id),
    true,
  )
  unsubscribe()
})

test('dedupeKey returns the same message without duplicating', async () => {
  _resetInboxForTest()
  const first = await createPush({ type: 'text', text: 'a', dedupeKey: 'k1' })
  const second = await createPush({ type: 'text', text: 'b', dedupeKey: 'k1' })
  assert.equal(second.deduplicated, true)
  assert.equal(second.message.id, first.message.id)
  const list = await listInboxMessages()
  assert.equal(list.messages.filter((m) => m.dedupeKey === 'k1').length, 1)
})

test('open flag emits inbox_open_target with route', async () => {
  _resetInboxForTest()
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  await createPush({ type: 'text', text: 'x', open: true, route: { tmuxPaneId: '%3', sessionName: 's' } })
  assert.equal(events.length, 2)
  assert.equal(events[1].type, 'inbox_open_target')
  if (events[1].type === 'inbox_open_target') assert.equal(events[1].route.tmuxPaneId, '%3')
  unsubscribe()
})

test('path push reads file, stores content-addressed asset, mime guessed', async () => {
  _resetInboxForTest()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-push-'))
  const filePath = path.join(dir, 'shot.png')
  writeFileSync(filePath, Buffer.from('fake-png-bytes'))
  const { message } = await createPush({ type: 'file', path: filePath })
  assert.equal(message.type, 'image')
  assert.equal(message.name, 'shot.png')
  assert.equal(message.mime, 'image/png')
  assert.ok(message.assetId)
  const asset = await getInboxAsset(message.assetId!)
  assert.equal(asset?.size, Buffer.byteLength('fake-png-bytes'))
})

test('sensitive paths are rejected', async () => {
  assert.equal(isSensitivePath('/home/u/.ssh/id_rsa'), true)
  assert.equal(isSensitivePath('/home/u/proj/.env'), true)
  assert.equal(isSensitivePath('/home/u/proj/output.png'), false)
  await assert.rejects(() => createPush({ type: 'file', path: `${os.homedir()}/.ssh/id_rsa` }), /sensitive/)
})

test('base64 push honors declared sha256', async () => {
  _resetInboxForTest()
  const content = Buffer.from('video-bytes')
  const { createHash } = await import('node:crypto')
  const sha = createHash('sha256').update(content).digest('hex')
  const { message } = await createPush({
    type: 'file',
    base64: content.toString('base64'),
    name: 'clip.mp4',
    declaredSha256: sha,
  })
  assert.equal(message.type, 'video')
  await assert.rejects(
    () => createPush({ type: 'file', base64: content.toString('base64'), declaredSha256: '0'.repeat(64) }),
    /sha256 mismatch/,
  )
})

test('markInboxRead tracks readBy/readAt and emits batch update', async () => {
  _resetInboxForTest()
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  const { message } = await createPush({ type: 'text', text: 'unread' })
  const { changed } = await markInboxRead([message.id], 'dev-1')
  assert.equal(changed, 1)
  const updated = events.find((e) => e.type === 'inbox_message_updated')
  assert.ok(updated && 'messages' in updated && updated.messages.some((m) => m.id === message.id))
  // 全局已读语义：readAt 已写，unreadOnly 过滤掉它
  assert.ok(updated && 'messages' in updated && !!updated.messages.find((m) => m.id === message.id)?.readAt)
  const unread = await listInboxMessages({ unreadForDevice: 'dev-1', unreadOnly: true })
  assert.equal(
    unread.messages.some((m) => m.id === message.id),
    false,
  )
  assert.equal(unread.unreadCount, 0)
  // deviceId 只给计数不过滤：已读消息留在历史
  const all = await listInboxMessages({ unreadForDevice: 'dev-1' })
  assert.equal(
    all.messages.some((m) => m.id === message.id),
    true,
  )
  unsubscribe()
})

test('archiveInboxMessages only closes read; unarchive restores; events batch with rev', async () => {
  _resetInboxForTest()
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  const { message: unread } = await createPush({ type: 'text', text: 'new' })
  const { message: read } = await createPush({ type: 'text', text: 'old' })
  await markInboxRead([read.id], 'dev-1')
  // 未读 id 被服务端拒绝归档（前端 bug 也关不了未读）
  const result = await archiveInboxMessages([unread.id, read.id])
  assert.equal(result.changed, 1)
  assert.equal(result.skippedUnread, 1)
  const active = await listInboxMessages({})
  assert.deepEqual(
    active.messages.map((m) => m.id),
    [unread.id],
  )
  const archived = await listInboxMessages({ view: 'archived' })
  assert.deepEqual(
    archived.messages.map((m) => m.id),
    [read.id],
  )
  assert.ok(archived.messages[0].archivedAt)
  // view=all 不 filt：镜像需要全量
  const all = await listInboxMessages({ view: 'all' })
  assert.equal(all.messages.length, 2)
  // 归档经 updated 批量事件 + rev 广播（不引入新事件类型）
  const archEvent = events.filter((e) => e.type === 'inbox_message_updated').at(-1)
  assert.ok(archEvent && 'messages' in archEvent && archEvent.messages.some((m) => m.id === read.id && !!m.archivedAt))
  // 幂等：再归档同一条 changed=0 且不重发事件
  const before = events.length
  const again = await archiveInboxMessages([read.id])
  assert.equal(again.changed, 0)
  assert.equal(events.length, before)
  // 恢复：回活动视图
  const restored = await archiveInboxMessages([read.id], false)
  assert.equal(restored.changed, 1)
  const activeAfter = await listInboxMessages({})
  assert.equal(
    activeAfter.messages.some((m) => m.id === read.id),
    true,
  )
  unsubscribe()
})

test('deleteInboxMessages soft-deletes to trash; restore and purge complete lifecycle', async () => {
  _resetInboxForTest()
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  const { message } = await createPush({ type: 'text', text: 'bye', dedupeKey: 'dk' })
  const { removed } = await deleteInboxMessages([message.id])
  assert.equal(removed, 1)
  // 软删：走 updated 事件而非 deleted；消息带 deletedAt 留在 store
  const trashed = events.find((e) => e.type === 'inbox_message_updated')
  assert.ok(trashed && 'messages' in trashed && trashed.messages.some((m) => m.id === message.id && !!m.deletedAt))
  assert.equal((await listInboxMessages({})).messages.length, 0)
  assert.deepEqual(
    (await listInboxMessages({ view: 'trash' })).messages.map((m) => m.id),
    [message.id],
  )
  // 进回收站即摘 dedupe：同 key 重 push 生成新消息不冲突
  const again = await createPush({ type: 'text', text: 'new', dedupeKey: 'dk' })
  assert.equal(again.deduplicated, false)
  // 恢复：回活动视图，deletedAt 清除
  const { restored } = await restoreInboxMessages([message.id])
  assert.equal(restored, 1)
  const active = await listInboxMessages({})
  assert.equal(
    active.messages.some((m) => m.id === message.id && !m.deletedAt),
    true,
  )
  // 再进回收站 → purge 物理移除：deleted 事件 + 从 store 消失
  await deleteInboxMessages([message.id])
  const before = events.length
  const { purged } = await purgeInboxMessages([message.id])
  assert.equal(purged, 1)
  const deleted = events.slice(before).find((e) => e.type === 'inbox_message_deleted')
  assert.ok(deleted && 'ids' in deleted && deleted.ids.includes(message.id) && typeof deleted.rev === 'number')
  assert.equal(
    (await listInboxMessages({ view: 'all' })).messages.some((m) => m.id === message.id),
    false,
  )
  // purge 只能清回收站里的——活动消息 purge 不动
  const { message: live } = await createPush({ type: 'text', text: 'keep' })
  assert.equal((await purgeInboxMessages([live.id])).purged, 0)
  assert.equal(
    (await listInboxMessages({})).messages.some((m) => m.id === live.id),
    true,
  )
  unsubscribe()
})

test('trash retention expires after 7 days via sweep', async () => {
  _resetInboxForTest()
  const { message } = await createPush({ type: 'text', text: 'doomed' })
  await deleteInboxMessages([message.id])
  // 直接把 deletedAt 改老到回收站时限外，重写 store 文件模拟超期
  const storePath = path.join(process.env.TMUXGO_CONFIG_DIR!, 'agent-inbox.json')
  const raw = JSON.parse(await readFile(storePath, 'utf8')) as {
    messages: { id: string; deletedAt?: string }[]
    revision: number
  }
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
  raw.messages = raw.messages.map((m) => (m.id === message.id ? { ...m, deletedAt: old } : m))
  await writeFile(storePath, `${JSON.stringify(raw)}\n`)
  _resetInboxForTest({ keepStore: true })
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  // 下一次 push 触发 sweep：超期回收站条目物理清除 + deleted 事件
  await createPush({ type: 'text', text: 'trigger' })
  assert.equal(
    (await listInboxMessages({ view: 'all' })).messages.some((m) => m.id === message.id),
    false,
  )
  const deleted = events.find((e) => e.type === 'inbox_message_deleted')
  assert.ok(deleted && 'ids' in deleted && deleted.ids.includes(message.id))
  unsubscribe()
})

test('markInboxRead with read=false restores unread state', async () => {
  _resetInboxForTest()
  const { message } = await createPush({ type: 'text', text: 'flip' })
  await markInboxRead([message.id], 'dev-1')
  assert.equal((await listInboxMessages({ unreadOnly: true })).messages.length, 0)
  const { changed } = await markInboxRead([message.id], 'dev-1', false)
  assert.equal(changed, 1)
  // 全局语义：readAt 与 readBy 同时清空，任何端都按未读算
  const found = (await listInboxMessages({ view: 'all' })).messages.find((m) => m.id === message.id)
  assert.equal(found?.readAt, undefined)
  assert.deepEqual(found?.readBy, [])
  assert.equal((await listInboxMessages({ unreadForDevice: 'dev-1' })).unreadCount, 1)
})

test('list stats reports message count and asset bytes excluding trash', async () => {
  _resetInboxForTest()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-stats-'))
  const filePath = path.join(dir, 'a.bin')
  writeFileSync(filePath, Buffer.alloc(100, 1))
  const { message: withAsset } = await createPush({ type: 'file', path: filePath })
  await createPush({ type: 'text', text: 'x' })
  const before = (await listInboxMessages({})).stats
  assert.equal(before.messages, 2)
  assert.equal(before.maxMessages, 1000)
  assert.equal(before.assetBytes, 100)
  assert.equal(before.maxAssetBytes, 512 * 1024 * 1024)
  // 进回收站：消息数下降但 asset 仍被引用（purge 才释放）
  await deleteInboxMessages([withAsset.id])
  const after = (await listInboxMessages({})).stats
  assert.equal(after.messages, 1)
  assert.equal(after.assetBytes, 100)
  await purgeInboxMessages([withAsset.id])
  const purged = (await listInboxMessages({})).stats
  assert.equal(purged.messages, 1)
  assert.equal(purged.assetBytes, 0)
})

test('link type requires http url', async () => {
  _resetInboxForTest()
  await assert.rejects(() => createPush({ type: 'link', linkUrl: 'javascript:alert(1)' }), /http/)
  const { message } = await createPush({ type: 'link', linkUrl: 'https://example.com/x', title: 'ex' })
  assert.equal(message.type, 'link')
})

test('path push refuses sensitive targets through symlink', async () => {
  _resetInboxForTest()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-inbox-link-'))
  try {
    const secret = path.join(dir, '.env.production')
    await writeFile(secret, 'KEY=1')
    const link = path.join(dir, 'innocent.png')
    await symlink(secret, link)
    await assert.rejects(() => createPush({ type: 'file', path: link }), /sensitive/i)
    // 目录名含敏感段的真实目标同样拦截
    const sshDir = path.join(dir, '.ssh')
    await mkdir(sshDir)
    await writeFile(path.join(sshDir, 'config'), 'Host x')
    await assert.rejects(() => createPush({ type: 'file', path: path.join(sshDir, 'config') }), /sensitive/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('corrupt store is backed up instead of silently wiped', async () => {
  _resetInboxForTest()
  await createPush({ type: 'text', text: 'seed' })
  const store = path.join(process.env.TMUXGO_CONFIG_DIR!, 'agent-inbox.json')
  await writeFile(store, '{broken json')
  _resetInboxForTest({ keepStore: true })
  const { messages } = await listInboxMessages()
  assert.equal(messages.length, 0)
  const dir = await readdir(path.dirname(store))
  assert.ok(dir.some((f) => f.includes('.corrupt-')))
})

test('sanitizeFileName keeps basename and strips unsafe chars', () => {
  assert.equal(sanitizeFileName('../../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('a/b\\c?.png'), 'c_.png')
  assert.equal(sanitizeFileName('..'), 'file')
})
