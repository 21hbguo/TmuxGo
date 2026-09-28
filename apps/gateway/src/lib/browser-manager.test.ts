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
