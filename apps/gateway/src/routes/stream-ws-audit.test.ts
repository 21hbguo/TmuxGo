import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import { flushAuditWrites } from '../lib/audit-log.js'

// auth 开关在模块加载时读取环境变量，先置空密码再走免 ticket 路径
process.env.TMUXGO_AUTH_PASSWORD = ''
const { streamRoutes } = await import('./stream.js')
const { agentMonitor } = await import('../lib/agent-monitor.js')

const SECRET = 'SECRET-WS-BODY-DO-NOT-LOG'

async function setup(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-ws-audit-'))
  const file = path.join(dir, 'audit.ndjson')
  const previous = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_AUDIT_LOG = file
  const app = Fastify()
  await app.register(websocket)
  await app.register(streamRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  t.after(async () => {
    await app.close()
    // 测试只挂载 streamRoutes，不走 index.ts 的 onClose 钩子——
    // 单例 monitor 被 subscribe 拉起后自带轮询定时器，需显式停掉防悬挂
    agentMonitor.stop()
    if (previous === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { port, file }
}

function readAudit(file: string) {
  try {
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

// appendAuditEvent 是 fire-and-forget：每次读盘前先 flush 掉在飞的写入，再判断条数。
// 旧写法单纯轮询，慢盘/CPU 抢占下会在写入还没落盘时就读到空文件（CI 上 0 !== 4）。
async function waitAuditCount(file: string, count: number, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await flushAuditWrites()
    const events = readAudit(file)
    if (events.length >= count || Date.now() > deadline) return events
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// 等客户端确实收到某类回执：说明服务端处理完了该消息（审计调用已发出），
// 避免用固定 sleep 猜服务端进度
async function waitReplies(replies: Record<string, unknown>[], done: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  return replies
}

test('stream ws audits connect, control messages and protocol errors without bodies', async (t) => {
  const { port, file } = await setup(t)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`)
  const replies: Record<string, unknown>[] = []
  ws.addEventListener('message', (event) => replies.push(JSON.parse(String(event.data))))
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  t.after(() => ws.close())

  // keepalive：pong 回来但不产生审计行
  ws.send(JSON.stringify({ type: 'ping' }))
  // 成功控制消息：input 正文绝不能落盘
  ws.send(JSON.stringify({ type: 'input', data: SECRET }))
  // 未知 type：协议错误
  ws.send(JSON.stringify({ type: 'bogus_type' }))
  // 非 JSON：协议错误
  ws.send('not-json-at-all')

  // ping/input/bogus/非 JSON 四条都已回执 → 服务端处理完毕，再去等在飞的审计写入
  await waitReplies(
    replies,
    () => replies.some((r) => r.type === 'pong') && replies.filter((r) => r.type === 'error').length >= 2,
  )
  const events = await waitAuditCount(file, 4)
  const raw = readFileSync(file, 'utf8')

  // 连接审计（既有）+ input 成功 + bogus invalid + 非 JSON invalid；ping 无行
  assert.equal(events.length, 4, JSON.stringify(events))
  const connect = events.find((e) => e.action === 'ws-stream-connect')
  assert.ok(connect)
  assert.equal(connect.result, 'success')
  assert.equal(connect.method, 'WS')

  const input = events.find((e) => e.action === 'ws-stream-input')
  assert.ok(input)
  assert.equal(input.result, 'success')
  assert.equal(input.statusCode, 200)
  assert.equal(input.actor, 'anonymous')

  const bogus = events.find((e) => e.action === 'ws-stream-bogus_type')
  assert.ok(bogus)
  assert.equal(bogus.result, 'failure')
  assert.equal(bogus.statusCode, 400)
  assert.equal(bogus.message, 'invalid')

  const malformed = events.find((e) => e.action === 'ws-stream-message')
  assert.ok(malformed)
  assert.equal(malformed.result, 'failure')
  assert.equal(malformed.message, 'invalid')

  assert.ok(!events.some((e) => e.action === 'ws-stream-ping'), 'keepalive must not be audited')
  assert.ok(!raw.includes(SECRET), 'audit log leaked message body')

  // 客户端侧仍收到原有错误回执（行为不变）
  assert.ok(replies.some((r) => r.type === 'connected'))
  assert.ok(replies.some((r) => r.type === 'pong'))
  assert.ok(replies.filter((r) => r.type === 'error').length >= 2)
})

test('stream ws audits agent register and denied share-like failures stay generic', async (t) => {
  const { port, file } = await setup(t)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`)
  ws.addEventListener('error', () => {})
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  t.after(() => ws.close())

  ws.send(
    JSON.stringify({
      type: 'register',
      host: { id: 'audit-host', name: 'audit', address: 'local' },
      version: '1.0',
    }),
  )
  // agent-event 校验失败（未注册 payload 缺失）→ 下游异常类审计，不回落下游错误详情
  ws.send(JSON.stringify({ type: 'agent-event', event: { bogus: true }, paneId: 'audit-host:%1' }))

  const events = await waitAuditCount(file, 3)
  const register = events.find((e) => e.action === 'ws-stream-register')
  assert.ok(register)
  assert.equal(register.result, 'success')
  assert.equal(register.hostId, 'audit-host')

  const agentEvent = events.find((e) => e.action === 'ws-stream-agent-event')
  assert.ok(agentEvent)
  assert.equal(agentEvent.result, 'failure')
  // 失败类别词而非下游错误正文——审计不回显资源存在性/内部细节
  assert.ok(['error', 'invalid'].includes(agentEvent.message))
})
