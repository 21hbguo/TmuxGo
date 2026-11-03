import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import test from 'node:test'
import { clientEventRoutes } from './client-events.js'

// 客户端诊断上报（移动端/输入法）是排障面，不是事件推送面：
// 这里锁住「落盘格式、trim 规则、空请求不写盘、recent 能回读」四条契约——
// 线上排查就靠这份 ndjson，格式漂了等于现场没了
function tempLog() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-client-events-'))
  return path.join(dir, 'events.ndjson')
}

async function withApp<T>(logPath: string, fn: (app: ReturnType<typeof Fastify>) => Promise<T>) {
  const previous = process.env.TMUXGO_CLIENT_EVENTS_LOG
  process.env.TMUXGO_CLIENT_EVENTS_LOG = logPath
  const app = Fastify()
  await app.register(clientEventRoutes)
  try {
    return await fn(app)
  } finally {
    await app.close()
    if (previous === undefined) delete process.env.TMUXGO_CLIENT_EVENTS_LOG
    else process.env.TMUXGO_CLIENT_EVENTS_LOG = previous
  }
}

test('client-events appends trimmed ndjson and recent reads it back', async () => {
  const logPath = tempLog()
  await withApp(logPath, async (app) => {
    const posted = await app.inject({
      method: 'POST',
      url: '/client-events',
      payload: {
        sessionId: 'session-local-dev',
        events: [
          {
            type: 'keyboard-open',
            text: 'x'.repeat(1200),
            numbers: Array.from({ length: 50 }, (_, index) => index),
            nested: { ok: true, huge: 'y'.repeat(5000) },
          },
        ],
      },
    })
    assert.equal(posted.statusCode, 200)
    assert.deepEqual(posted.json(), { ok: true, count: 1 })

    const recent = await app.inject({ method: 'GET', url: '/client-events/recent' })
    assert.equal(recent.statusCode, 200)
    assert.equal(recent.headers['cache-control'], 'no-store')
    const body = recent.json() as {
      ok: boolean
      path: string
      events: { sessionId: string; receivedAt: string; event: Record<string, unknown> }[]
    }
    assert.equal(body.path, logPath)
    assert.equal(body.events.length, 1)
    assert.equal(body.events[0].sessionId, 'session-local-dev')
    assert.ok(body.events[0].receivedAt)
    const event = body.events[0].event as {
      type: string
      text: string
      numbers: number[]
      nested: { ok: boolean; huge: string }
    }
    assert.equal(event.type, 'keyboard-open')
    // trim 规则：字符串 1000、数组 40、对象值同样递归裁剪
    assert.equal(event.text.length, 1000)
    assert.equal(event.numbers.length, 40)
    assert.equal(event.nested.ok, true)
    assert.equal(event.nested.huge.length, 1000)
  })
})

test('client-events keeps only the last MAX_EVENTS entries of one batch', async () => {
  const logPath = tempLog()
  await withApp(logPath, async (app) => {
    const events = Array.from({ length: 200 }, (_, index) => ({ type: 'batch', index }))
    const posted = await app.inject({ method: 'POST', url: '/client-events', payload: { events } })
    assert.deepEqual(posted.json(), { ok: true, count: 160 })
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 160)
    // 截尾保留最新的事件，最早的那 40 条直接丢
    assert.equal(JSON.parse(lines[0]).event.index, 40)
    assert.equal(JSON.parse(lines.at(-1) as string).event.index, 199)
  })
})

test('client-events ignores empty or malformed batches without creating a log file', async () => {
  const logPath = tempLog()
  await withApp(logPath, async (app) => {
    const empty = await app.inject({ method: 'POST', url: '/client-events', payload: { events: [] } })
    assert.deepEqual(empty.json(), { ok: true, count: 0 })
    const malformed = await app.inject({ method: 'POST', url: '/client-events', payload: { events: 'nope' } })
    assert.deepEqual(malformed.json(), { ok: true, count: 0 })
    assert.throws(() => readFileSync(logPath, 'utf8'), /ENOENT/)
    const recent = await app.inject({ method: 'GET', url: '/client-events/recent' })
    assert.deepEqual((recent.json() as { events: unknown[] }).events, [])
  })
})
