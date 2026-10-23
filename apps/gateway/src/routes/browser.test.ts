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

// 路由层桩：只替换 manager 的对外方法，绝不真起浏览器
function stubManager(t: { after: (fn: () => void) => void }) {
  const inst = browserManager.get('local')!
  const orig = { launch: inst.launch, stop: inst.stop, navigate: inst.navigate, status: inst.status }
  const calls = { launch: 0, stop: 0, navigate: [] as { url: string; targetId?: string }[] }
  const state = { launchError: null as Error | null, navigateError: null as Error | null }
  inst.launch = async () => {
    calls.launch++
    if (state.launchError) throw state.launchError
    inst.state = 'ready'
    inst.engine = '/usr/bin/fake-chrome'
  }
  inst.stop = async () => {
    calls.stop++
    inst.state = 'idle'
  }
  inst.navigate = async (url: string, targetId?: string) => {
    calls.navigate.push({ url, targetId })
    if (state.navigateError) throw state.navigateError
    return { ok: true }
  }
  inst.status = () => ({
    state: inst.state,
    engine: inst.engine,
    pid: (inst as unknown as { proc?: { pid?: number } }).proc?.pid ?? null,
    cdpPort: inst.cdpPort,
    pages: [],
    activeTargetId: null,
    error: inst.error ?? undefined,
  })
  t.after(() => {
    inst.launch = orig.launch
    inst.stop = orig.stop
    inst.navigate = orig.navigate
    inst.status = orig.status
    inst.state = 'idle'
    inst.engine = null
    inst.error = null
    inst.cdpPort = null
  })
  return { calls, state, inst }
}

test('GET /browser/status returns the manager status shape without an error key when healthy', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const { inst } = stubManager(t)
  inst.state = 'ready'
  inst.cdpPort = 9222
  const res = await fetch(`http://127.0.0.1:${port}/api/browser/status`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.state, 'ready')
  assert.equal(body.cdpPort, 9222)
  assert.deepEqual(body.pages, [])
  assert.equal(body.activeTargetId, null)
  // 健康时 error 走 undefined（JSON 里不出现），前端据此不显示错误条
  assert.equal('error' in body, false)

  inst.state = 'error'
  inst.error = 'CDP socket closed'
  const failed = (await (await fetch(`http://127.0.0.1:${port}/api/browser/status`)).json()) as Record<string, unknown>
  assert.equal(failed.state, 'error')
  assert.equal(failed.error, 'CDP socket closed')
})

test('POST /browser/stop is idempotent from the API surface', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const { calls } = stubManager(t)
  for (const _ of [1, 2]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/stop`, { method: 'POST' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
  }
  // 重复 stop 不该被路由层挡住——幂等由 manager 保证
  assert.equal(calls.stop, 2)
})

test('POST /browser/navigate forwards url/targetId and maps failures to 400', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const { calls, state } = stubManager(t)
  const ok = await fetch(`http://127.0.0.1:${port}/api/browser/navigate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/a', targetId: 'p1' }),
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true })
  assert.deepEqual(calls.navigate, [{ url: 'https://example.com/a', targetId: 'p1' }])

  state.navigateError = new Error('net::ERR_NAME_NOT_RESOLVED')
  const failed = await fetch(`http://127.0.0.1:${port}/api/browser/navigate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://nowhere.invalid' }),
  })
  assert.equal(failed.status, 400)
  assert.deepEqual(await failed.json(), { error: 'net::ERR_NAME_NOT_RESOLVED' })
})

test('POST /browser/navigate rejects an empty or oversized url before reaching the manager', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const { calls } = stubManager(t)
  for (const url of ['', 'x'.repeat(4097)]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    assert.equal(res.status, 400, `url len=${url.length}`)
    assert.ok((await res.json()).error)
  }
  assert.equal(calls.navigate.length, 0)
})

test('POST /browser/launch maps a missing binary to 400 and other failures to 502', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const { calls, state } = stubManager(t)
  const ok = await fetch(`http://127.0.0.1:${port}/api/browser/launch`, { method: 'POST' })
  assert.equal(ok.status, 200)
  const okBody = (await ok.json()) as Record<string, unknown>
  assert.equal(okBody.ok, true)
  assert.equal(okBody.state, 'ready')

  state.launchError = new Error('NO_BROWSER_BINARY')
  const missing = await fetch(`http://127.0.0.1:${port}/api/browser/launch`, { method: 'POST' })
  assert.equal(missing.status, 400)
  const missingBody = (await missing.json()) as { error: string; hint: string }
  assert.equal(missingBody.error, 'NO_BROWSER_BINARY')
  // 两条错误路径都要带安装提示，前端直接展示
  assert.match(missingBody.hint, /playwright/)

  state.launchError = new Error('DevToolsActivePort timeout')
  const broken = await fetch(`http://127.0.0.1:${port}/api/browser/launch`, { method: 'POST' })
  assert.equal(broken.status, 502)
  const brokenBody = (await broken.json()) as { error: string; hint: string }
  assert.equal(brokenBody.error, 'DevToolsActivePort timeout')
  assert.match(brokenBody.hint, /playwright/)
  assert.equal(calls.launch, 3)
})

test('control op status/stop/navigate mirror the REST surface', async (t) => {
  const { app, port } = await setup()
  t.after(() => app.close())
  const { calls, state, inst } = stubManager(t)
  inst.state = 'ready'
  const ctrl = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${port}/api/v1/control/browser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tmuxgo-env': '1', 'x-tmuxgo-agent-token': AGENT_TOKEN },
      body: JSON.stringify(body),
    })
  const status = (await (await ctrl({ op: 'status' })).json()) as Record<string, unknown>
  assert.equal(status.ok, true)
  assert.equal(status.state, 'ready')

  const nav = (await (await ctrl({ op: 'navigate', url: 'https://example.com/b' })).json()) as Record<string, unknown>
  assert.equal(nav.ok, true)
  assert.deepEqual(nav.result, { ok: true })

  state.navigateError = new Error('browser not connected')
  const navFail = await ctrl({ op: 'navigate', url: 'https://example.com/c' })
  assert.equal(navFail.status, 400)
  const navFailBody = (await navFail.json()) as { message: string; code: string }
  // 控制面错误形态与 REST 不同：{ message, code }
  assert.deepEqual(navFailBody, { message: 'browser not connected', code: 'BROWSER_OP_FAILED' })

  const stop = await ctrl({ op: 'stop' })
  assert.equal(stop.status, 200)
  assert.deepEqual(await stop.json(), { ok: true })
  assert.ok(calls.stop >= 1)
})
