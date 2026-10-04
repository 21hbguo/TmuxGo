import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { WebSocket } from 'ws'

// 免 ticket 路径：先置空密码再加载路由
process.env.TMUXGO_AUTH_PASSWORD = ''
const AGENT_TOKEN = 'test-browser-token'
process.env.TMUXGO_AGENT_EVENT_TOKEN = AGENT_TOKEN
const { browserRoutes } = await import('./browser.js')
const { browserManager, resolveBrowserBinary } = await import('../lib/browser-manager.js')

const hasBrowser = !!resolveBrowserBinary()

async function setup() {
  const app = Fastify()
  await app.register(websocket)
  await app.register(browserRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { app, port }
}

test('browser setup endpoint reports binary probe result', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const res = await fetch(`http://127.0.0.1:${port}/api/browser/setup`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.status.installed, hasBrowser)
  if (!hasBrowser) assert.match(body.hint, /playwright/)
})

test('browser control endpoint enforces env guard', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  // 无 token/无 env header 一律 401（token guard 先跑）
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/control/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'status' }),
  })
  assert.equal(res.status, 401)
})

test('browser control endpoint accepts valid token + env and returns status', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/control/browser`, {
    method: 'POST',
    headers: { 'x-tmuxgo-env': '1', 'x-tmuxgo-agent-token': AGENT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'status' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(['idle', 'launching', 'ready', 'error'].includes(body.state))
})

test('stream pause sent during addClient bind window is applied after bind', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const inst = browserManager.get('local')!
  // addClient 人为挂起，造出"ws 已 open 但 client 未落地"的窗口期
  const origAdd = inst.addClient
  const origPause = inst.clientPause
  const pauses: boolean[] = []
  let releaseAdd: (() => void) | null = null
  inst.addClient = ((send: Parameters<typeof origAdd>[0]) =>
    new Promise<void>((r) => (releaseAdd = r)).then(() => origAdd.call(inst, send))) as typeof inst.addClient
  inst.clientPause = (async (c: Parameters<typeof origPause>[0], p: boolean) => {
    pauses.push(p)
    return origPause.call(inst, c, p)
  }) as typeof inst.clientPause
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser/stream`)
    await new Promise((r) => ws.addEventListener('open', r))
    ws.send(JSON.stringify({ type: 'pause' }))
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(pauses, []) // 窗口期只记账，不下发
    releaseAdd!()
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(pauses, [true]) // bind 落地后补应用
    ws.close()
  } finally {
    inst.addClient = origAdd
    inst.clientPause = origPause
  }
})

test('browser full loop: launch → WS frames → navigate → snapshot → click', { timeout: 45000 }, async (t) => {
  if (!hasBrowser) return t.skip('no chromium binary found')
  const { app, port } = await setup()
  t.after(async () => {
    await browserManager.get('local')!.stop()
    await app.close()
  })
  const launch = await fetch(`http://127.0.0.1:${port}/api/browser/launch`, { method: 'POST' })
  assert.equal(launch.status, 200)
  const status = await launch.json()
  assert.equal(status.state, 'ready')
  assert.ok(status.pages.length >= 1)

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser/stream`)
  const messages: Record<string, unknown>[] = []
  const waitType = (type: string, timeout = 15000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const hit = messages.find((m) => m.type === type)
      if (hit) return resolve(hit)
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${type}`)), timeout)
      ws.addEventListener('message', function onMsg(e) {
        const m = JSON.parse(String(e.data))
        if (m.type === type) {
          clearTimeout(timer)
          ws.removeEventListener('message', onMsg)
          resolve(m)
        }
      })
    })
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))))
  await new Promise((resolve) => ws.addEventListener('open', resolve))

  await waitType('status')
  await waitType('targets')
  const frame = await waitType('frame')
  assert.ok(typeof frame.data === 'string' && frame.data.length > 500, 'frame should be non-trivial jpeg b64')

  // 经 WS 导航到本地 page，等 frameNavigated 推 page 消息
  ws.send(JSON.stringify({ type: 'navigate', url: 'about:blank#smoke' }))
  await new Promise((r) => setTimeout(r, 500))

  // snapshot/click/press 走 control 面验证 CDP 链路
  const inst = browserManager.get('local')!
  const snap = (await inst.snapshot()) as { url: string; elements: unknown[] } | undefined
  assert.ok(snap && typeof snap.url === 'string')
  const shot = await inst.screenshot()
  assert.ok(shot.length > 1000)

  ws.close()
})
