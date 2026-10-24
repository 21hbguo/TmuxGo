import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IPty } from 'node-pty'
import { setPtySpawnForTest } from '../terminal-attachment.js'
import { setPrepareSessionAttachForTest } from '../tmux-policy.js'
import {
  acquireSharedTerminal,
  countSharedTerminalGraceTimers,
  countSharedTerminals,
  clearSharedTerminalGraceTimers,
  getSharedTerminal,
  resetSharedTerminalsForTest,
  setHubGraceMsForTest,
  type SharedTerminalSubscriber,
} from './shared-terminal.js'
import { streamPerfMetrics } from '../perf-metrics.js'

type FakePty = IPty & { emitData: (data: string) => void; emitExit: (code: number) => void; killed: boolean }

function fakePty(pid: number): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
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
    resize() {},
    write() {},
    kill() {
      pty.killed = true
    },
    pause() {},
    resume() {},
    clear() {},
    killed: false,
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
    const pty = fakePty(2000 + spawns.length)
    spawns.push(pty)
    return pty as unknown as IPty
  })
  return spawns
}

function subscriber(): SharedTerminalSubscriber & { output: string[] } {
  const output: string[] = []
  return {
    output,
    onSharedOutput(filtered: string) {
      output.push(filtered)
    },
    onSharedExit() {},
    onSharedRedrawBoundary() {},
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setupEnv() {
  setPtySpawnForTest(() => {
    throw new Error('pty spawn not mocked')
  })
  setPrepareSessionAttachForTest(async () => {})
}

test('a hub survives the last unsubscribe and is reused for a reconnect within the grace window', async (t) => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetSharedTerminalsForTest()
  setHubGraceMsForTest(120)
  t.after(() => {
    setHubGraceMsForTest(null)
    resetSharedTerminalsForTest()
  })
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 80, rows: 24 })
  const sub = subscriber()
  hub.subscribe(sub)
  spawns[0].emitData('MIRROR-BEFORE-DISCONNECT')
  await sleep(20)
  const seqBefore = hub.mirror.seq
  assert.equal(seqBefore > 0, true, '断开前镜像要有内容才谈得上增量')

  hub.unsubscribe(sub)
  // 最后一个订阅者走了：hub 仍在（宽限期），PTY 没被杀
  assert.equal(countSharedTerminals(), 1)
  assert.equal(countSharedTerminalGraceTimers(), 1)
  assert.equal(spawns[0].killed, false)

  const again = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 80, rows: 24 })
  assert.equal(again.reused, true, '宽限期内重连必须复用同一个 hub')
  assert.equal(again.hub, hub, '必须是同一个 hub 实例')
  assert.equal(spawns.length, 1, '不该重建 PTY')
  assert.equal(countSharedTerminalGraceTimers(), 0, '复活时要摘掉销毁定时器')
  // 镜像还在：seq 接着原来的走，客户端报 lastSeq 就能只补增量
  assert.equal(again.hub.mirror.seq, seqBefore)
  assert.equal((streamPerfMetrics.hubGraceReused as number) >= 1, true)

  // 复活后定时器必须真的没了：越过原到期时刻也不许被误杀
  await sleep(150)
  assert.equal(countSharedTerminals(), 1, '复位活的 hub 不能再被宽限定时器杀掉')
  assert.equal(spawns[0].killed, false)
})

test('the hub is destroyed once the grace window lapses', async (t) => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetSharedTerminalsForTest()
  setHubGraceMsForTest(40)
  t.after(() => {
    setHubGraceMsForTest(null)
    resetSharedTerminalsForTest()
  })
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 80, rows: 24 })
  const sub = subscriber()
  hub.subscribe(sub)
  spawns[0].emitData('BEFORE')
  await sleep(10)
  hub.unsubscribe(sub)
  assert.equal(countSharedTerminals(), 1, '刚断开时还在宽限期内')
  await sleep(90)
  assert.equal(countSharedTerminals(), 0, '宽限到期要销毁')
  assert.equal(countSharedTerminalGraceTimers(), 0)
  assert.equal(spawns[0].killed, true, '到期必须杀掉孤儿 tmux client')
  assert.equal((streamPerfMetrics.hubGraceExpired as number) >= 1, true)

  // 超时后重连：新 hub、新 PTY，只能走整快照路径
  const again = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 80, rows: 24 })
  assert.equal(again.reused, false)
  assert.notEqual(again.hub, hub)
  assert.equal(spawns.length, 2)
})

test('a pty exit during the grace window cancels the timer instead of resurrecting the hub', async (t) => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetSharedTerminalsForTest()
  setHubGraceMsForTest(60)
  t.after(() => {
    setHubGraceMsForTest(null)
    resetSharedTerminalsForTest()
  })
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 80, rows: 24 })
  const sub = subscriber()
  hub.subscribe(sub)
  hub.unsubscribe(sub)
  assert.equal(countSharedTerminalGraceTimers(), 1)

  // 宽限期内 session 被 kill / PTY 自己退出：该死就死，宽限不救
  spawns[0].emitExit(0)
  assert.equal(countSharedTerminals(), 0)
  assert.equal(countSharedTerminalGraceTimers(), 0, '定时器要一并摘掉，免得到期对已删 hub 动手')
  await sleep(100)
  // 到期后也不该有任何动作（不诈尸、不重复计数销毁）
  assert.equal(countSharedTerminals(), 0)
  assert.equal(getSharedTerminal('local', 'dev'), null)
})

test('grace 0 restores the previous immediate-destroy behaviour', async (t) => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetSharedTerminalsForTest()
  setHubGraceMsForTest(0)
  t.after(() => {
    setHubGraceMsForTest(null)
    resetSharedTerminalsForTest()
  })
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 80, rows: 24 })
  const sub = subscriber()
  hub.subscribe(sub)
  hub.unsubscribe(sub)
  assert.equal(countSharedTerminals(), 0, 'grace=0 时立刻销毁')
  assert.equal(countSharedTerminalGraceTimers(), 0, '不排定时器')
  assert.equal(spawns[0].killed, true)
})

test('shutdown clears pending grace timers', async (t) => {
  setupEnv()
  setupPtySpawn()
  resetSharedTerminalsForTest()
  setHubGraceMsForTest(200)
  t.after(() => {
    setHubGraceMsForTest(null)
    resetSharedTerminalsForTest()
  })
  const { hub } = await acquireSharedTerminal({ hostId: 'local', sessionName: 'dev', cols: 80, rows: 24 })
  const sub = subscriber()
  hub.subscribe(sub)
  hub.unsubscribe(sub)
  assert.equal(countSharedTerminalGraceTimers(), 1)
  // 关停路径：定时器全部清掉，别在快照/关 server 中途突然杀 PTY
  clearSharedTerminalGraceTimers()
  assert.equal(countSharedTerminalGraceTimers(), 0)
  assert.equal(countSharedTerminals(), 1, '清定时器不等于立刻销毁')
})
