import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import type { PickResult } from '../lib/browser-manager.js'

// 免 ticket 路径：先置空密码再加载路由
process.env.TMUXGO_AUTH_PASSWORD = ''
const AGENT_TOKEN = 'test-browser-pick-token'
process.env.TMUXGO_AGENT_EVENT_TOKEN = AGENT_TOKEN
const { browserRoutes } = await import('./browser.js')
const { browserManager } = await import('../lib/browser-manager.js')

const CTRL_HEADERS = {
  'content-type': 'application/json',
  'x-tmuxgo-env': '1',
  'x-tmuxgo-agent-token': AGENT_TOKEN,
}

async function setup() {
  const app = Fastify()
  await app.register(websocket)
  await app.register(browserRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  return { app, port: typeof address === 'object' && address ? address.port : 0 }
}

// 路由层测试：替换 manager 方法为桩，不碰真实浏览器
function stubManager(t: { after: (fn: () => void) => void }) {
  const inst = browserManager.get('local')!
  const origPick = inst.pickElement
  const origCancel = inst.cancelPick
  const state = {
    result: { cancelled: true } as PickResult,
    pickError: null as Error | null,
  }
  const pickCalls: { targetId?: string; timeoutMs?: number }[] = []
  const cancelCalls: (string | undefined)[] = []
  inst.pickElement = async (targetId?: string, timeoutMs?: number) => {
    pickCalls.push({ targetId, timeoutMs })
    if (state.pickError) throw state.pickError
    return state.result
  }
  inst.cancelPick = async (targetId?: string) => {
    cancelCalls.push(targetId)
  }
  t.after(() => {
    inst.pickElement = origPick
    inst.cancelPick = origCancel
  })
  return { state, pickCalls, cancelCalls }
}

test('REST /browser/pick forwards params and returns result', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const m = stubManager(t)
  const picked: PickResult = {
    selector: 'a#go',
    ref: 'p0',
    tag: 'a',
    text: 'go',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    url: 'https://x/',
    title: 'X',
  }
  m.state.result = picked
  const res = await fetch(`http://127.0.0.1:${port}/api/browser/pick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetId: 't9', timeoutMs: 3000 }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.result, picked)
  assert.deepEqual(m.pickCalls, [{ targetId: 't9', timeoutMs: 3000 }])
})

test('REST /browser/pick maps PICK_ALREADY_ACTIVE to 409', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const m = stubManager(t)
  m.state.pickError = new Error('PICK_ALREADY_ACTIVE')
  const res = await fetch(`http://127.0.0.1:${port}/api/browser/pick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'PICK_ALREADY_ACTIVE')
})

test('REST /browser/pick/cancel calls manager cancelPick', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const m = stubManager(t)
  const res = await fetch(`http://127.0.0.1:${port}/api/browser/pick/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetId: 't7' }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(m.cancelCalls, ['t7'])
})

test('control op pick/pickCancel dispatch to manager', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const m = stubManager(t)
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/control/browser`, {
    method: 'POST',
    headers: CTRL_HEADERS,
    body: JSON.stringify({ op: 'pick', targetId: 't3', timeoutMs: 5000 }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.result, { cancelled: true })
  assert.deepEqual(m.pickCalls, [{ targetId: 't3', timeoutMs: 5000 }])

  const res2 = await fetch(`http://127.0.0.1:${port}/api/v1/control/browser`, {
    method: 'POST',
    headers: CTRL_HEADERS,
    body: JSON.stringify({ op: 'pickCancel', targetId: 't3' }),
  })
  assert.equal(res2.status, 200)
  assert.deepEqual(m.cancelCalls, ['t3'])
})

test('control op pick schema enforces timeoutMs <= 120000', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const m = stubManager(t)
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/control/browser`, {
    method: 'POST',
    headers: CTRL_HEADERS,
    body: JSON.stringify({ op: 'pick', timeoutMs: 120001 }),
  })
  // ZodError 透出由全局 error handler 转 400；独立测试 app 里为 500，重点是不分发
  assert.ok(res.status >= 400)
  assert.equal(m.pickCalls.length, 0)
  const ok = await fetch(`http://127.0.0.1:${port}/api/v1/control/browser`, {
    method: 'POST',
    headers: CTRL_HEADERS,
    body: JSON.stringify({ op: 'pick', timeoutMs: 120000 }),
  })
  assert.equal(ok.status, 200)
  assert.equal(m.pickCalls.length, 1)
})
