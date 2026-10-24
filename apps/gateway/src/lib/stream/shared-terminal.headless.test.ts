// 无订阅者虚拟视口（herdr headless_cols/rows 等价物）的单元测试。
// 全程假 PTY + 假 list-clients：只验证「何时钉、何时不钉、钉到多少」，
// 真 tmux 上的窗口尺寸变化由 shared-terminal.headless-tmux.test.ts 覆盖。
import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IPty } from 'node-pty'
import { setPtySpawnForTest } from '../terminal-attachment.js'
import { setPrepareSessionAttachForTest } from '../tmux-policy.js'
import { streamPerfMetrics } from '../perf-metrics.js'
import {
  acquireSharedTerminal,
  pinHeadlessViewport,
  peekHeadlessViewport,
  resetSharedTerminalsForTest,
  setCountAttachedClientsForTest,
  setHeadlessPinDelayForTest,
  setHeadlessViewportForTest,
  setHubGraceMsForTest,
  type SharedTerminalSubscriber,
} from './shared-terminal.js'

type FakePty = IPty & {
  emitData: (data: string) => void
  emitExit: (code: number) => void
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
}

function fakePty(pid: number): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
  const resizes: Array<{ cols: number; rows: number }> = []
  const pty: FakePty = {
    pid,
    cols: 80,
    rows: 24,
    process: 'tmux',
    handleFlowControl: false,
    onData: (listener: (data: string) => void) => {
      dataListeners.push(listener)
      return { dispose() {} }
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListeners.push(listener)
      return { dispose() {} }
    },
    resize: (cols: number, rows: number) => {
      resizes.push({ cols, rows })
    },
    write() {},
    kill() {
      pty.killed = true
    },
    pause() {},
    resume() {},
    clear() {},
    killed: false,
    resizes,
    emitData: (data: string) => {
      for (const listener of dataListeners) listener(data)
    },
    emitExit: (code: number) => {
      for (const listener of exitListeners) listener({ exitCode: code })
    },
  }
  return pty
}

function setupPtySpawn() {
  const spawns: FakePty[] = []
  setPtySpawnForTest(() => {
    const pty = fakePty(3000 + spawns.length)
    spawns.push(pty)
    return pty as unknown as IPty
  })
  return spawns
}

function subscriber(): SharedTerminalSubscriber {
  return { onSharedOutput() {}, onSharedExit() {}, onSharedRedrawBoundary() {} }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error('waitFor timed out')
}

function setupEnv(t: { after: (fn: () => void) => void }) {
  setPtySpawnForTest(() => {
    throw new Error('pty spawn not mocked')
  })
  setPrepareSessionAttachForTest(async () => {})
  resetSharedTerminalsForTest()
  setHubGraceMsForTest(200)
  setHeadlessPinDelayForTest(0)
  setHeadlessViewportForTest({ cols: 120, rows: 40 })
  setCountAttachedClientsForTest(async () => 1)
  t.after(() => {
    setHubGraceMsForTest(null)
    setHeadlessPinDelayForTest(null)
    setHeadlessViewportForTest(null)
    setCountAttachedClientsForTest(null)
    resetSharedTerminalsForTest()
  })
}

test('the last unsubscribe pins the idle window to the virtual viewport', async (t) => {
  setupEnv(t)
  const spawns = setupPtySpawn()
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 100, rows: 30 })
  const sub = subscriber()
  hub.subscribe(sub)
  hub.unsubscribe(sub)
  await waitFor(() => hub.cols === 120 && hub.rows === 40)
  assert.deepEqual(spawns[0].resizes.at(-1), { cols: 120, rows: 40 }, 'PTY 要真的 resize 到虚拟视口')
  assert.equal((streamPerfMetrics.hubHeadlessPinned as number) >= 1, true)
})

test('a reconnect inside the grace window clears the pin on the next fit', async (t) => {
  setupEnv(t)
  const spawns = setupPtySpawn()
  const first = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 100, rows: 30 })
  const sub = subscriber()
  first.hub.subscribe(sub)
  first.hub.unsubscribe(sub)
  await waitFor(() => first.hub.cols === 120)
  // 宽限期内重连：复用同一个 hub，尺寸由调用方（StreamSession.attach）重新 fit
  const again = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 142, rows: 38 })
  assert.equal(again.reused, true)
  assert.equal(again.hub, first.hub)
  again.hub.resizePty(142, 38)
  assert.deepEqual(spawns[0].resizes.at(-1), { cols: 142, rows: 38 }, '钉住的尺寸必须能被新的 fit 覆盖')
  assert.equal(again.hub.cols, 142)
})

test('the pin is skipped while another tmux client shares the session', async (t) => {
  setupEnv(t)
  const spawns = setupPtySpawn()
  setCountAttachedClientsForTest(async () => 2)
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 100, rows: 30 })
  const sub = subscriber()
  hub.subscribe(sub)
  hub.unsubscribe(sub)
  await sleep(40)
  assert.equal(hub.cols, 100, '别的 client 还在看，不能改 window 尺寸')
  assert.equal(spawns[0].resizes.length, 0)
  assert.equal((streamPerfMetrics.hubHeadlessPinSkipped as number) >= 1, true)
})

test('a quick reconnect inside the pin delay never touches the window', async (t) => {
  setupEnv(t)
  const spawns = setupPtySpawn()
  // 真延迟 60ms：模拟切标签「断开—几十毫秒—连回」，钉尺寸必须被取消
  setHeadlessPinDelayForTest(60)
  t.after(() => setHeadlessPinDelayForTest(null))
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 100, rows: 30 })
  const first = subscriber()
  hub.subscribe(first)
  hub.unsubscribe(first)
  await sleep(20)
  hub.subscribe(subscriber())
  await sleep(120)
  assert.equal(hub.cols, 100, '连回来的人自己会 fit，别先钉一次再改回')
  assert.equal(spawns[0].resizes.length, 0)
})

test('a subscriber that arrives mid-pin wins: no resize after the count resolves', async (t) => {
  setupEnv(t)
  const spawns = setupPtySpawn()
  let resolveCount: ((value: number) => void) | undefined
  setCountAttachedClientsForTest(
    () =>
      new Promise<number>((resolve) => {
        resolveCount = resolve
      }),
  )
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 100, rows: 30 })
  const first = subscriber()
  hub.subscribe(first)
  hub.unsubscribe(first)
  // 钉尺寸等 list-clients 回来期间，新订阅者已经进场（重连/换标签）
  hub.subscribe(subscriber())
  resolveCount?.(1)
  await sleep(40)
  assert.equal(hub.cols, 100, '有订阅者时绝不能钉')
  assert.equal(spawns[0].resizes.length, 0)
})

test('an unsupported list-clients degrades once per host instead of throwing', async (t) => {
  setupEnv(t)
  setupPtySpawn()
  let calls = 0
  setCountAttachedClientsForTest(async () => {
    calls += 1
    throw new Error('unknown option: -F')
  })
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 100, rows: 30 })
  const sub = subscriber()
  hub.subscribe(sub)
  hub.unsubscribe(sub)
  await sleep(30)
  assert.equal(hub.cols, 100, '查不到 client 数就保持旧行为')
  assert.equal(await pinHeadlessViewport(hub), false)
  assert.equal(calls, 1, '第一次失败后记 host 标记，不再重复查询')
})

test('TMUXGO_HEADLESS_COLS=0 disables the pin', async (t) => {
  setupEnv(t)
  const spawns = setupPtySpawn()
  const previous = process.env.TMUXGO_HEADLESS_COLS
  process.env.TMUXGO_HEADLESS_COLS = '0'
  setHeadlessViewportForTest(null)
  t.after(() => {
    if (previous === undefined) delete process.env.TMUXGO_HEADLESS_COLS
    else process.env.TMUXGO_HEADLESS_COLS = previous
  })
  assert.equal(peekHeadlessViewport(), null)
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 100, rows: 30 })
  const sub = subscriber()
  hub.subscribe(sub)
  hub.unsubscribe(sub)
  await sleep(30)
  assert.equal(hub.cols, 100)
  assert.equal(spawns[0].resizes.length, 0)
})
