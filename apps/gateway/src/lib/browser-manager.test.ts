import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserInstance } from './browser-manager.js'

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
