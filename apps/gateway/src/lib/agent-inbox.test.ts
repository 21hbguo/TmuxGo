import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createPush,
  deleteInboxMessages,
  getInboxAsset,
  isSensitivePath,
  listInboxMessages,
  markInboxRead,
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

test('markInboxRead tracks readBy and emits update', async () => {
  _resetInboxForTest()
  const events: InboxEvent[] = []
  const unsubscribe = subscribeInbox((event) => events.push(event))
  const { message } = await createPush({ type: 'text', text: 'unread' })
  const { changed } = await markInboxRead([message.id], 'dev-1')
  assert.equal(changed, 1)
  assert.equal(
    events.some((e) => e.type === 'inbox_message_updated'),
    true,
  )
  const unread = await listInboxMessages({ unreadForDevice: 'dev-1' })
  assert.equal(
    unread.messages.some((m) => m.id === message.id),
    false,
  )
  assert.equal(unread.unreadCount, 0)
  unsubscribe()
})

test('deleteInboxMessages removes message and dedupe entry', async () => {
  _resetInboxForTest()
  const { message } = await createPush({ type: 'text', text: 'bye', dedupeKey: 'dk' })
  const { removed } = await deleteInboxMessages([message.id])
  assert.equal(removed, 1)
  const again = await createPush({ type: 'text', text: 'new', dedupeKey: 'dk' })
  assert.equal(again.deduplicated, false)
})

test('link type requires http url', async () => {
  _resetInboxForTest()
  await assert.rejects(() => createPush({ type: 'link', linkUrl: 'javascript:alert(1)' }), /http/)
  const { message } = await createPush({ type: 'link', linkUrl: 'https://example.com/x', title: 'ex' })
  assert.equal(message.type, 'link')
})

test('sanitizeFileName keeps basename and strips unsafe chars', () => {
  assert.equal(sanitizeFileName('../../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('a/b\\c?.png'), 'c_.png')
  assert.equal(sanitizeFileName('..'), 'file')
})
