import '../test-env.js'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import test, { type TestContext } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { BrowserInstance, resolveBrowserBinary } from './browser-manager.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

// pick 的 CDP 链路 stub：attach 给假 session；Runtime.evaluate 对注入脚本挂起（模拟用户未操作），
// 对 cleanup eval（window.__tgPickCleanup?.()）则释放挂起的 pick——等价于页面内 cleanup 被调
function stubbedInst() {
  const inst = new BrowserInstance()
  inst.activeTargetId = 't1'
  let pickResolve: ((v: { result?: { value?: unknown } }) => void) | null = null
  const evals: string[] = []
  inst.attach = async () => 'sid-1'
  inst.detach = async () => {}
  inst.cmd = ((method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Runtime.evaluate') {
      const expr = typeof params.expression === 'string' ? params.expression : ''
      evals.push(expr)
      if (expr === 'window.__tgPickCleanup?.()') {
        pickResolve?.({ result: { value: { cancelled: true } } })
        return Promise.resolve({})
      }
      return new Promise<{ result?: { value?: unknown } }>((r) => {
        pickResolve = r
      })
    }
    return Promise.resolve({})
  }) as BrowserInstance['cmd']
  return { inst, evals, resolvePick: (v: unknown) => pickResolve?.({ result: { value: v } }) }
}

test('pickElement without active page rejects NO_ACTIVE_PAGE', async () => {
  const inst = new BrowserInstance()
  await assert.rejects(inst.pickElement(), /NO_ACTIVE_PAGE/)
})

test('pickElement without cdp connection propagates error', async () => {
  const inst = new BrowserInstance()
  inst.activeTargetId = 't1'
  await assert.rejects(inst.pickElement('t1'), /browser not connected/)
})

test('pickElement resolves picked result and clears state', async () => {
  const { inst, resolvePick } = stubbedInst()
  const p = inst.pickElement('t1')
  await tick()
  const picked = {
    selector: 'a#go',
    ref: 'p0',
    tag: 'a',
    text: 'go',
    rect: { x: 1, y: 2, width: 3, height: 4 },
    url: 'https://x/',
    title: 'X',
  }
  resolvePick(picked)
  assert.deepEqual(await p, picked)
})

test('pickElement same target twice rejects PICK_ALREADY_ACTIVE; cancelPick resolves cancelled', async () => {
  const { inst, evals } = stubbedInst()
  const p = inst.pickElement('t1', 60000)
  await tick()
  await assert.rejects(inst.pickElement('t1'), /PICK_ALREADY_ACTIVE/)
  await inst.cancelPick('t1')
  assert.equal((await p).cancelled, true)
  assert.ok(evals.includes('window.__tgPickCleanup?.()'))
})

test('pickElement timeout issues cleanup eval and resolves cancelled', async () => {
  const { inst, evals } = stubbedInst()
  const res = await inst.pickElement('t1', 30)
  assert.equal(res.cancelled, true)
  assert.ok(evals.includes('window.__tgPickCleanup?.()'))
})

test('pickElement page-side alreadyActive rejects PICK_ALREADY_ACTIVE and frees the slot', async () => {
  const inst = new BrowserInstance()
  inst.activeTargetId = 't1'
  let attaches = 0
  inst.attach = async () => (attaches++, 'sid-1')
  inst.detach = async () => {}
  let pendingResolve: ((v: { result?: { value?: unknown } }) => void) | null = null
  let first = true
  inst.cmd = ((method: string, params: Record<string, unknown> = {}) => {
    if (method !== 'Runtime.evaluate') return Promise.resolve({})
    const expr = typeof params.expression === 'string' ? params.expression : ''
    if (expr === 'window.__tgPickCleanup?.()') {
      pendingResolve?.({ result: { value: { cancelled: true } } })
      return Promise.resolve({})
    }
    if (first) {
      first = false
      return Promise.resolve({ result: { value: { alreadyActive: true } } })
    }
    return new Promise<{ result?: { value?: unknown } }>((r) => {
      pendingResolve = r
    })
  }) as BrowserInstance['cmd']
  await assert.rejects(inst.pickElement('t1'), /PICK_ALREADY_ACTIVE/)
  // map 若没清理第二次会在 attach 前就抛；走到 attach 说明槽位已释放
  const res = await inst.pickElement('t1', 30)
  assert.equal(res.cancelled, true)
  assert.equal(attaches, 2)
})

test('pickElement navigation/context error resolves cancelled instead of hanging', async () => {
  const inst = new BrowserInstance()
  inst.activeTargetId = 't1'
  inst.attach = async () => 'sid-1'
  inst.detach = async () => {}
  inst.cmd = ((method: string) =>
    method === 'Runtime.evaluate'
      ? Promise.reject(new Error('Inspected target navigated or closed'))
      : Promise.resolve({})) as BrowserInstance['cmd']
  const res = await inst.pickElement('t1')
  assert.equal(res.cancelled, true)
})

test('cancelPick without active pick is a no-op eval', async () => {
  const { inst, evals } = stubbedInst()
  await inst.cancelPick('t1')
  assert.deepEqual(evals, ['window.__tgPickCleanup?.()'])
})

// view client 的 CDP 链路 stub：attach 给固定 session，cmd 记录调用；captureScreenshot 回静态帧
function boundInst() {
  const inst = new BrowserInstance()
  inst.state = 'ready'
  inst.activeTargetId = 't1'
  const calls: { method: string; params: Record<string, unknown> }[] = []
  inst.attach = async () => 'sid-1'
  inst.detach = async () => {}
  inst.cmd = ((method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    if (method === 'Page.captureScreenshot') return Promise.resolve({ data: 'SNAP' })
    return Promise.resolve({})
  }) as BrowserInstance['cmd']
  return { inst, calls }
}
const frameHandlersOf = (inst: BrowserInstance) =>
  (
    inst as unknown as { sessionEventHandlers: Map<string, Map<string, Set<(p: unknown) => void>>> }
  ).sessionEventHandlers
    .get('sid-1')!
    .get('Page.screencastFrame')!

test('clientPause stops screencast without detaching; in-flight frames ack but not forward', async () => {
  const { inst, calls } = boundInst()
  const sent: Record<string, unknown>[] = []
  const client = await inst.addClient((m) => sent.push(m))
  assert.equal(client.sessionId, 'sid-1')
  assert.equal(calls.filter((c) => c.method === 'Page.startScreencast').length, 1)

  await inst.clientPause(client, true)
  assert.equal(calls.filter((c) => c.method === 'Page.stopScreencast').length, 1)
  assert.equal(client.sessionId, 'sid-1') // session 保活不 detach
  sent.length = 0
  for (const h of frameHandlersOf(inst)) {
    h({ data: 'F', sessionId: 7, metadata: { deviceWidth: 1, deviceHeight: 1 } })
  }
  assert.equal(calls.filter((c) => c.method === 'Page.screencastFrameAck').length, 1)
  assert.equal(sent.length, 0)

  await inst.clientPause(client, false)
  assert.equal(calls.filter((c) => c.method === 'Page.startScreencast').length, 2)
  assert.ok(calls.some((c) => c.method === 'Page.captureScreenshot'))
  assert.deepEqual(sent[0], { type: 'frame', data: 'SNAP' })
})

test('paused client does not restart screencast on rebind or resize; resume uses latest size', async () => {
  const { inst, calls } = boundInst()
  const client = await inst.addClient(() => {})
  await inst.clientPause(client, true)
  const starts = () => calls.filter((c) => c.method === 'Page.startScreencast').length
  const n = starts()
  // tab 切换/页面销毁补绑不恢复推流；resize 只记尺寸、更新布局、不动流
  await inst.bindClient(client, 't1')
  await inst.clientResize(client, 1024, 768)
  assert.equal(starts(), n)
  assert.ok(calls.some((c) => c.method === 'Emulation.setDeviceMetricsOverride'))

  await inst.clientPause(client, false)
  const last = calls.filter((c) => c.method === 'Page.startScreencast').pop()!
  assert.deepEqual([last.params.maxWidth, last.params.maxHeight], [1024, 768])
})

// resume 的补帧链路含多个 await：attach 给可变 sessionId + captureScreenshot 挂起可控，
// 用来造"恢复途中又暂停/换绑"的迟到帧竞态
function deferredShotInst() {
  const inst = new BrowserInstance()
  inst.state = 'ready'
  inst.activeTargetId = 't1'
  let sidN = 0
  let resolveShot: ((v: { data: string }) => void) | null = null
  inst.attach = async () => `sid-${++sidN}`
  inst.detach = async () => {}
  inst.cmd = ((method: string) =>
    method === 'Page.captureScreenshot'
      ? new Promise<{ data: string }>((r) => {
          resolveShot = r
        })
      : Promise.resolve({})) as BrowserInstance['cmd']
  return { inst, resolveShot: (v: string) => resolveShot?.({ data: v }), hasShot: () => !!resolveShot }
}

test('resume snapshot frame is dropped when the client is re-paused mid-capture', async () => {
  const { inst, resolveShot, hasShot } = deferredShotInst()
  const sent: Record<string, unknown>[] = []
  const client = await inst.addClient((m) => sent.push(m))
  await inst.clientPause(client, true)
  const resume = inst.clientPause(client, false)
  await tick()
  assert.ok(hasShot()) // 截图已在途
  await inst.clientPause(client, true) // 截图未回又最小化
  resolveShot('LATE')
  await resume
  assert.equal(sent.filter((m) => m.type === 'frame').length, 0)
})

test('resume snapshot frame is dropped when the client rebound to another session', async () => {
  const { inst, resolveShot, hasShot } = deferredShotInst()
  const sent: Record<string, unknown>[] = []
  const client = await inst.addClient((m) => sent.push(m))
  await inst.clientPause(client, true)
  const resume = inst.clientPause(client, false)
  await tick()
  assert.ok(hasShot())
  // 换绑新 session：旧页截图不得发回客户端
  await inst.bindClient(client, 't1')
  resolveShot('LATE')
  await resume
  assert.equal(sent.filter((m) => m.type === 'frame').length, 0)
})

// ---- 假 CDP：本地 http 提供 /json/version + ws 提供命令应答/事件注入，绝不真起 Chrome ----
type CdpCall = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }
// ws 的 @types 在这个仓库是 `export =` 命名空间形态，named import 拿不到 Server；走 createRequire + 本地接口
const wsRequire = createRequire(import.meta.url)
interface CdpServerSocket {
  readyState: number
  send: (data: string) => void
  terminate: () => void
  on: (event: 'close' | 'message', handler: (payload: { toString: () => string }) => void) => void
}
interface CdpServer {
  on: (event: 'connection', handler: (socket: CdpServerSocket) => void) => void
  close: (cb: () => void) => void
}

class FakeCdp {
  private httpServer: http.Server
  private wsServer: CdpServer
  private sockets = new Set<CdpServerSocket>()
  calls: CdpCall[] = []
  handlers = new Map<string, (call: CdpCall) => unknown>()
  port = 0
  wsUrl = ''

  static async start(): Promise<FakeCdp> {
    const fake = new FakeCdp()
    await fake.listen()
    return fake
  }

  private constructor() {
    const ServerImpl = wsRequire('ws').Server as new (opts: { server: http.Server }) => CdpServer
    this.httpServer = http.createServer(this.onRequest)
    this.wsServer = new ServerImpl({ server: this.httpServer })
    this.wsServer.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('message', (raw) => this.onCommand(socket, raw.toString()))
    })
  }

  private onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ webSocketDebuggerUrl: this.wsUrl }))
      return
    }
    res.writeHead(404)
    res.end()
  }

  private listen() {
    return new Promise<void>((resolve) => {
      this.httpServer.listen(0, '127.0.0.1', () => {
        this.port = (this.httpServer.address() as { port: number }).port
        this.wsUrl = `ws://127.0.0.1:${this.port}/devtools/browser/fake`
        resolve()
      })
    })
  }

  private onCommand(socket: CdpServerSocket, raw: string) {
    const call = JSON.parse(raw) as CdpCall
    this.calls.push(call)
    const handler = call.method ? this.handlers.get(call.method) : undefined
    // 无 handler 的命令一律成功应答 {}，需要挂起的用例显式注册一个返回 Promise 的 handler
    const result = handler ? handler(call) : {}
    Promise.resolve(result).then(
      (value) => {
        if (call.id === undefined) return
        if (socket.readyState === 1) socket.send(JSON.stringify({ id: call.id, result: value ?? {} }))
      },
      (err: unknown) => {
        if (call.id === undefined || socket.readyState !== 1) return
        socket.send(
          JSON.stringify({ id: call.id, error: { message: err instanceof Error ? err.message : String(err) } }),
        )
      },
    )
  }

  push(event: Record<string, unknown>) {
    for (const socket of this.sockets) if (socket.readyState === 1) socket.send(JSON.stringify(event))
  }

  // 模拟 CDP 侧断连（Chrome 崩溃/连接被掐）
  cut() {
    for (const socket of this.sockets) socket.terminate()
  }

  methods() {
    return this.calls.map((call) => call.method)
  }

  callsOf(method: string) {
    return this.calls.filter((call) => call.method === method)
  }

  async close() {
    this.cut()
    await new Promise<void>((resolve) => this.wsServer.close(() => resolve()))
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()))
  }
}

// 起一条假 CDP：profile 目录里写好 DevToolsActivePort 指向假 http 端口，
// spawnBrowser 换成 no-op（绝不真起 Chrome），launch 走真实 waitForPort/fetchWsUrl/connectSocket
async function launchFake(t: TestContext) {
  const fake = await FakeCdp.start()
  t.after(() => fake.close())
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-browser-cfg-'))
  const previousConfig = process.env.TMUXGO_CONFIG_DIR
  const previousBin = process.env.TMUXGO_BROWSER_PATH
  process.env.TMUXGO_CONFIG_DIR = configDir
  // resolveBrowserBinary 只做 existsSync，用任意存在的文件冒充二进制
  const fakeBin = path.join(configDir, 'fake-chrome')
  writeFileSync(fakeBin, '#!/bin/sh\n')
  process.env.TMUXGO_BROWSER_PATH = fakeBin
  t.after(() => {
    if (previousConfig === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfig
    if (previousBin === undefined) delete process.env.TMUXGO_BROWSER_PATH
    else process.env.TMUXGO_BROWSER_PATH = previousBin
    rmSync(configDir, { recursive: true, force: true })
  })
  const profile = path.join(configDir, 'browser-profile')
  mkdirSync(profile, { recursive: true })
  const inst = new BrowserInstance()
  // 只替换进程启动：端口文件由「浏览器」在启动时写出（launch 会先删残留文件），
  // 其后的 waitForPort/fetchWsUrl/connectSocket 全部走真实实现
  ;(inst as unknown as { spawnBrowser: () => void }).spawnBrowser = () => {
    writeFileSync(path.join(profile, 'DevToolsActivePort'), `${fake.port}\n/devtools/browser/fake`)
  }
  t.after(() => inst.stop())
  return { fake, inst, profile, configDir, fakeBin }
}

test('launch reaches ready through a fake CDP endpoint and reports status', async (t) => {
  const { fake, inst } = await launchFake(t)
  await inst.launch()
  assert.equal(inst.state, 'ready')
  assert.equal(inst.cdpPort, fake.port)
  // 首个 target 要等 setDiscoverTargets 的事件补进来；这里先断言命令确实发了
  assert.ok(fake.methods().includes('Target.setDiscoverTargets'))
  const status = inst.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.cdpPort, fake.port)
  assert.equal(status.pid, null)
  // 幂等：ready 状态下重复 launch 不再发命令
  const before = fake.calls.length
  await inst.launch()
  assert.equal(fake.calls.length, before)
})

test('launch reports NO_BROWSER_BINARY when no browser is installed', async (t) => {
  const previousBin = process.env.TMUXGO_BROWSER_PATH
  const previousPath = process.env.PATH
  const previousHome = process.env.HOME
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-nohome-'))
  process.env.TMUXGO_BROWSER_PATH = ''
  process.env.PATH = emptyHome
  // 探测还看 ~/.cache/ms-playwright：把 HOME 指到空目录，保证三档全空
  process.env.HOME = emptyHome
  t.after(() => {
    if (previousBin === undefined) delete process.env.TMUXGO_BROWSER_PATH
    else process.env.TMUXGO_BROWSER_PATH = previousBin
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(emptyHome, { recursive: true, force: true })
  })
  assert.equal(resolveBrowserBinary(), null)
  const inst = new BrowserInstance()
  await assert.rejects(inst.launch(), /NO_BROWSER_BINARY/)
  // 没二进制时状态仍是 idle：没有进入 launching，前端据此提示安装
  assert.equal(inst.state, 'idle')
})

test('launch degrades to error when the CDP endpoint never becomes reachable', async (t) => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-browser-cfg-'))
  const previousConfig = process.env.TMUXGO_CONFIG_DIR
  const previousBin = process.env.TMUXGO_BROWSER_PATH
  process.env.TMUXGO_CONFIG_DIR = configDir
  const fakeBin = path.join(configDir, 'fake-chrome')
  writeFileSync(fakeBin, '#!/bin/sh\n')
  process.env.TMUXGO_BROWSER_PATH = fakeBin
  t.after(() => {
    if (previousConfig === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfig
    if (previousBin === undefined) delete process.env.TMUXGO_BROWSER_PATH
    else process.env.TMUXGO_BROWSER_PATH = previousBin
    rmSync(configDir, { recursive: true, force: true })
  })
  // 端口文件指向一个没人监听的端口：fetchWsUrl 必然 ECONNREFUSED
  const profile = path.join(configDir, 'browser-profile')
  mkdirSync(profile, { recursive: true })
  const dead = await new Promise<number>((resolve) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
  const inst = new BrowserInstance()
  ;(inst as unknown as { spawnBrowser: () => void }).spawnBrowser = () => {
    writeFileSync(path.join(profile, 'DevToolsActivePort'), `${dead}\n/devtools/browser/fake`)
  }
  t.after(() => inst.stop())
  await assert.rejects(inst.launch(), /ECONNREFUSED|connect/i)
  assert.equal(inst.state, 'error')
  assert.match(inst.status().error ?? '', /ECONNREFUSED|connect/i)
  // 端口已探到、只是握手失败：实现保留 cdpPort 供排障，状态由 state=error 表达
  assert.equal(inst.status().cdpPort, dead)
})

test('launch degrades to error when /json/version is not JSON', async (t) => {
  const { inst, profile } = await launchFake(t)
  // 换一个只回空体的 http 端点冒充 CDP：解析失败必须落到 bad /json/version
  const junk = http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('not-json')
  })
  await new Promise<void>((resolve) => junk.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => junk.close(() => resolve())))
  ;(inst as unknown as { spawnBrowser: () => void }).spawnBrowser = () => {
    writeFileSync(path.join(profile, 'DevToolsActivePort'), `${(junk.address() as { port: number }).port}\nx`)
  }
  await assert.rejects(inst.launch(), /bad \/json\/version/)
  assert.equal(inst.state, 'error')
})
