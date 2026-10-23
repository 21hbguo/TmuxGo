import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { PASTE_BINARY_MAX_BYTES } from '../lib/stream/paste-binary.js'

// src/ws.d.ts 只声明了 ws 的 WebSocket 接口（类型层），运行时类要显式取，
// 否则 new WebSocket() 会落到全局 undici 实现上（拿不到 autoPong）
type WsClient = {
  readyState: number
  send(data: string | Buffer): void
  close(): void
  on(event: 'message', listener: (raw: Buffer) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  once(event: 'open', listener: () => void): void
  once(event: 'error', listener: (error: Error) => void): void
}
const WsClientImpl = createRequire(import.meta.url)('ws') as new (
  url: string,
  options?: { autoPong?: boolean },
) => WsClient
const WS_OPEN = 1

// auth 开关与心跳节奏都在模块加载时读取环境变量：整个文件在"开认证 + 5s 心跳"下跑，
// 每个连接必须持 ticket（scoped token 票或 share token 换的票），顺带把票据分支压住
process.env.TMUXGO_AUTH_USERNAME = 'heartzone'
process.env.TMUXGO_AUTH_PASSWORD = 'heartzone-pass'
process.env.TMUXGO_STREAM_PING_INTERVAL_MS = '5000'

const { streamRoutes } = await import('./stream.js')
const { agentManager } = await import('../agent-manager.js')
const { agentMonitor } = await import('../lib/agent-monitor.js')
const { issueScopedWebSocketTicket } = await import('../lib/auth.js')
const { shareLinkStore } = await import('../lib/share-links.js')
const { STREAM_PING_INTERVAL_MS } = await import('../lib/stream/stream-config.js')

type Frame = Record<string, any>

async function setup(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-stream-proto-'))
  const file = path.join(dir, 'audit.ndjson')
  const previousAudit = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_AUDIT_LOG = file
  const app = Fastify()
  await app.register(websocket)
  await app.register(streamRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  t.after(async () => {
    await app.close()
    // 只挂载 streamRoutes，没有 index.ts 的 onClose：monitor 单例被 subscribe 拉起后
    // 自带轮询定时器，必须显式停掉，否则 node --test 进程悬挂
    agentMonitor.stop()
    if (previousAudit === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAudit
    rmSync(dir, { recursive: true, force: true })
  })
  return { port, file }
}

function streamUrl(port: number, ticket?: string) {
  return `ws://127.0.0.1:${port}/api/stream${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`
}

// autoPong 默认 true：模拟"客户端正常回 pong"。停止回 pong 的用例单独关掉。
function connect(port: number, ticket?: string, autoPong = true) {
  const ws = new WsClientImpl(streamUrl(port, ticket), { autoPong })
  const frames: Frame[] = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame))
  ws.on('error', () => {})
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
  )
  const connected = (async () => {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return waitFrame(frames, (frame) => frame.type === 'connected')
  })()
  return { ws, frames, closed, connected }
}

async function waitFrame(frames: Frame[], match: (frame: Frame) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = frames.find(match)
    if (hit) return hit
    await delay(10)
  }
  throw new Error(`frame not received: ${JSON.stringify(frames)}`)
}

async function waitClosed(closed: Promise<{ code: number; reason: string }>, timeoutMs = 3000) {
  return Promise.race([
    closed,
    delay(timeoutMs).then(() => {
      throw new Error('socket did not close in time')
    }),
  ])
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function readAudit(file: string): Frame[] {
  try {
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Frame)
  } catch {
    return []
  }
}

// appendAuditEvent 是 fire-and-forget：等到预期条数/命中条件再断言
async function waitAudit(file: string, match: (event: Frame) => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = readAudit(file)
    const hit = events.filter(match)
    if (hit.length) return hit
    await delay(15)
  }
  return readAudit(file).filter(match)
}

function pasteFrame(header: string, payload: string | Buffer) {
  return Buffer.concat([Buffer.from(`${header}\n`, 'utf8'), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)])
}

test('rejects a stream connection without a ticket while auth is enabled', async (t) => {
  const { port, file } = await setup(t)
  const anonymous = connect(port)
  const closed = await waitClosed(anonymous.closed)
  assert.deepEqual(closed, { code: 1008, reason: 'Authentication required' })

  const connects = await waitAudit(file, (event) => event.action === 'ws-stream-connect')
  assert.equal(connects.length, 1)
  assert.equal(connects[0].result, 'failure')
  assert.equal(connects[0].statusCode, 1008)
  assert.equal(connects[0].actor, 'anonymous')
  // 未通过认证的连接不得产生任何消息级审计
  assert.equal(readAudit(file).length, 1)
})

test('denies input, resize and paste-data for a read-only share viewer', async (t) => {
  const { port, file } = await setup(t)
  const link = await shareLinkStore.create('local', 'shared-session', 30)
  const exchanged = await shareLinkStore.exchange(link.token)
  assert.ok(exchanged)
  const viewer = connect(port, exchanged.ticket)
  await viewer.connected

  viewer.ws.send(JSON.stringify({ type: 'input', data: 'touch /tmp/should-not-run' }))
  viewer.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  viewer.ws.send(pasteFrame('paste-data local shared-session', 'oversized paste body'))

  const denials = await waitAudit(file, (event) => event.message === 'denied')
  assert.deepEqual(denials.map((event) => event.action).sort(), [
    'ws-stream-input',
    'ws-stream-paste-data',
    'ws-stream-resize',
  ])
  for (const event of denials) {
    assert.equal(event.result, 'failure')
    assert.equal(event.statusCode, 403)
    assert.equal(event.actor, 'share')
    // 粘贴正文与输入内容一律不落盘，只留标识
    assert.ok(!JSON.stringify(event).includes('should-not-run'))
    assert.ok(!JSON.stringify(event).includes('oversized paste body'))
  }
  const errors = viewer.frames.filter((frame) => frame.type === 'error')
  assert.equal(errors.length, 3)
  for (const error of errors) assert.equal(error.code, 'SHARE_READ_ONLY')
  // 只读是拒写而不是断连：连接必须仍然可用
  assert.equal(viewer.ws.readyState, WS_OPEN)
})

test('closes a share socket once the underlying link is revoked', async (t) => {
  const { port } = await setup(t)
  const link = await shareLinkStore.create('local', 'revoked-session', 30)
  const exchanged = await shareLinkStore.exchange(link.token)
  assert.ok(exchanged)
  const viewer = connect(port, exchanged.ticket)
  await viewer.connected
  await shareLinkStore.revoke(link.id)

  viewer.ws.send(JSON.stringify({ type: 'input', data: 'x' }))
  const closed = await waitClosed(viewer.closed)
  assert.equal(closed.code, 1008)
  assert.equal(closed.reason, 'Share link is unavailable')
})

test('classifies invalid, mismatched and oversized paste-data frames', async (t) => {
  const { port, file } = await setup(t)
  // 受限 scope 只为关闭 monitor 扇出：本用例不关心 monitor 事件
  const { ticket } = await issueScopedWebSocketTicket('paste', { hosts: ['local'], sessions: ['test'] })
  const client = connect(port, ticket)
  await client.connected

  // 头缺 session（只有 host）：解析失败
  client.ws.send(pasteFrame('paste-data local', 'body'))
  assert.match(String((await waitFrame(client.frames, (frame) => frame.type === 'error')).message), /invalid frame/)

  // 未 attach 时任何声称目标都不可能匹配
  client.ws.send(pasteFrame('paste-data local some-session', 'body'))
  assert.match(
    String(
      (await waitFrame(client.frames, (frame) => frame.type === 'error' && /mismatch/.test(String(frame.message))))
        .message,
    ),
    /target mismatch/,
  )

  const oversized = Buffer.alloc(PASTE_BINARY_MAX_BYTES + 1, 0x61)
  client.ws.send(pasteFrame('paste-data local some-session', oversized))
  const tooLarge = await waitFrame(
    client.frames,
    (frame) => frame.type === 'error' && /too large/.test(String(frame.message)),
  )
  assert.match(String(tooLarge.message), /too large/)

  const audits = await waitAudit(file, (event) => event.action === 'ws-stream-paste-data', 3000)
  assert.equal(audits.length, 3)
  for (const event of audits) {
    assert.equal(event.result, 'failure')
    assert.equal(event.message, 'invalid')
    assert.equal(event.statusCode, 400)
  }
})

test('denies attach and register outside the ticket scope without echoing the target', async (t) => {
  const { port, file } = await setup(t)
  const { ticket } = await issueScopedWebSocketTicket('restricted', { hosts: ['allowed-host'], sessions: ['visible'] })
  const client = connect(port, ticket)
  await client.connected

  client.ws.send(JSON.stringify({ type: 'attach', hostId: 'other-host', sessionName: 'secret-session' }))
  const attachError = await waitFrame(client.frames, (frame) => frame.type === 'error')
  assert.equal(attachError.message, 'Access scope does not allow this session')
  // 越权拒绝不得回显目标名（资源存在性靠错误文案泄漏）
  assert.ok(!String(attachError.message).includes('secret-session'))

  client.ws.send(
    JSON.stringify({
      type: 'register',
      version: '1.0',
      host: { id: 'other-host', name: 'other', address: '127.0.0.1' },
    }),
  )
  const registerError = await waitFrame(
    client.frames,
    (frame) => frame.type === 'error' && /Access scope does not allow this host/.test(String(frame.message)),
  )
  assert.equal(registerError.message, 'Access scope does not allow this host')

  const denials = await waitAudit(file, (event) => event.message === 'denied')
  assert.deepEqual(denials.map((event) => event.action).sort(), ['ws-stream-attach', 'ws-stream-register'])
  for (const event of denials) assert.equal(event.statusCode, 403)
})

test('relays agent tmux results without writing message audit rows', async (t) => {
  const { port, file } = await setup(t)
  const { ticket } = await issueScopedWebSocketTicket('agent', { hosts: '*' })
  const client = connect(port, ticket)
  await client.connected

  client.ws.send(
    JSON.stringify({
      type: 'register',
      version: '1.0',
      host: { id: 'relay-host', name: 'relay', address: '127.0.0.1' },
    }),
  )
  const registered = await waitFrame(client.frames, (frame) => frame.type === 'registered')
  assert.equal(registered.agentId, 'relay-host')

  const pending = agentManager.executeTmux('relay-host', ['list-panes'], 3000)
  // register 自身会探一次 tmux hook（show-hooks），必须认领本次 executeTmux 的那条请求
  const request = await waitFrame(
    client.frames,
    (frame) => frame.type === 'tmux' && Array.isArray(frame.args) && frame.args[0] === 'list-panes',
  )
  client.ws.send(JSON.stringify({ type: 'tmux-result', requestId: request.requestId, stdout: '%1\n', stderr: '' }))
  assert.deepEqual(await pending, { stdout: '%1\n', stderr: '' })

  // 中继帧属于 agent 通道内部 RPC 回复：只放行，不得落消息级审计
  await delay(200)
  assert.equal(readAudit(file).filter((event) => event.action === 'ws-stream-tmux-result').length, 0)
  // 对照：register 本身有审计，证明"没有审计"不是审计文件没写
  assert.equal((await waitAudit(file, (event) => event.action === 'ws-stream-register')).length, 1)
})

test('keeps a client alive while it answers keepalive pings', async (t) => {
  const { port } = await setup(t)
  const { ticket } = await issueScopedWebSocketTicket('alive', { hosts: ['local'], sessions: ['test'] })
  const client = connect(port, ticket)
  await client.connected
  // 等到至少一次 ping/pong 往返（ws 客户端 autoPong 自动回）
  await delay(STREAM_PING_INTERVAL_MS + 1500)
  assert.equal(client.ws.readyState, WS_OPEN)
  client.ws.close()
})

test('terminates a client that stops answering keepalive pings', { timeout: 40000 }, async (t) => {
  const { port } = await setup(t)
  const { ticket } = await issueScopedWebSocketTicket('stalled', { hosts: ['local'], sessions: ['test'] })
  // autoPong=false：只收 ping 不回 pong，触发 3×interval 的 pong 超时 terminate
  const client = connect(port, ticket, false)
  await new Promise<void>((resolve, reject) => {
    client.ws.once('open', () => resolve())
    client.ws.once('error', reject)
  })
  const closed = await waitClosed(client.closed, STREAM_PING_INTERVAL_MS * 3 + STREAM_PING_INTERVAL_MS + 5000)
  // terminate 是硬断：客户端拿到 1006（异常关闭），不是 1008 的优雅关闭
  assert.equal(closed.code, 1006)
})
