// 真 tmux + 假 PTY：验证 attach 的 view 分流边界。view 的创建/归属走真实
// 隔离 tmux server（test-tmux 断言），PTY 用桩以便断言 hub key 与协议字段。
import '../../test-env.js'
import '../../test-tmux.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IPty } from 'node-pty'
import { setPtySpawnForTest } from '../terminal-attachment.js'
import { setPrepareSessionAttachForTest } from '../tmux-policy.js'
import { setRefreshExecForTest } from './stream-tmux.js'
import type { TmuxExecResult } from '../tmux-executor.js'
import { StreamSession, resetExclusiveOwnershipForTest, setWindowSizeQueryForTest } from './stream-session.js'
import {
  countSharedTerminals,
  resetSharedTerminalsForTest,
  setHubGraceMsForTest,
  sharedTerminalKey,
} from './shared-terminal.js'
import { setMirrorEnabledForTest } from './stream-config.js'
import { sweepViewSessions, viewSessionName } from '../view-sessions.js'
import { streamAttachMessageSchema } from '../request-validation.js'
import { TEST_TMUX_SESSION, execTmuxFile, killTestTmuxSession } from '../../test-tmux.js'

const VIEW_PREFIX = 'tmuxgo-view-'

type FakePty = IPty & {
  emitData: (data: string) => void
  killed: boolean
  writes: string[]
}

function fakePty(pid: number): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
  let killed = false
  const writes: string[] = []
  return {
    pid,
    cols: 80,
    rows: 24,
    process: 'tmux',
    handleFlowControl: false,
    write: (data: string) => writes.push(data),
    resize: () => {},
    kill: () => {
      killed = true
    },
    clear: () => {},
    pause: () => {},
    resume: () => {},
    onData: (listener: (data: string) => void) => {
      dataListeners.push(listener)
      return { dispose: () => {} }
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListeners.push(listener)
      return { dispose: () => {} }
    },
    emitData: (data: string) => {
      for (const listener of dataListeners) listener(data)
    },
    get killed() {
      return killed
    },
    get writes() {
      return writes
    },
  } as unknown as FakePty /* 桩：只实现测试用到的 IPty 成员 */
}

function createSocket() {
  const sent: Array<{ type?: string; sessionName?: string; data?: string }> = []
  const frames: string[] = []
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | Buffer) {
      const raw = String(data)
      frames.push(raw)
      if (raw.startsWith('{')) sent.push(JSON.parse(raw))
    },
    close() {},
  }
  return { socket, sent, frames }
}

function setupEnv() {
  setHubGraceMsForTest(0)
  setPrepareSessionAttachForTest(async () => {})
  setWindowSizeQueryForTest(async () => ({ cols: 80, rows: 24 }))
  setRefreshExecForTest(
    async () => ({ stdout: '1|/dev/pts/mock\n', stderr: '', host: null }) as unknown as TmuxExecResult,
  )
  // 关镜像：避免 capture-pane 基线与测试断言的海量 async 噪音竞争
  setMirrorEnabledForTest(false)
}

function teardownEnv() {
  setHubGraceMsForTest(null)
  setPtySpawnForTest(() => {
    throw new Error('pty spawn not mocked')
  })
  setPrepareSessionAttachForTest(null)
  setWindowSizeQueryForTest(null)
  setRefreshExecForTest(null)
  setMirrorEnabledForTest(null)
  resetSharedTerminalsForTest()
  resetExclusiveOwnershipForTest()
  delete process.env.TMUXGO_VIEWS
}

function setupPtySpawn() {
  const spawns: FakePty[] = []
  setPtySpawnForTest((_file, _args, options) => {
    const pty = fakePty(2000 + spawns.length)
    if (typeof options.cols === 'number') (pty as { cols: number }).cols = options.cols
    if (typeof options.rows === 'number') (pty as { rows: number }).rows = options.rows
    spawns.push(pty)
    return pty
  })
  return spawns
}

async function sessionNames(): Promise<string[]> {
  const { stdout } = await execTmuxFile('tmux', ['list-sessions', '-F', '#{session_name}']).catch(() => ({
    stdout: '',
  }))
  return String(stdout).split('\n').filter(Boolean)
}

async function resetBase() {
  await killTestTmuxSession()
  for (const name of await sessionNames()) {
    if (name.startsWith(VIEW_PREFIX)) await execTmuxFile('tmux', ['kill-session', '-t', name]).catch(() => {})
  }
  await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '80', '-y', '24'])
}

async function cleanupOwn() {
  await killTestTmuxSession()
  for (const name of await sessionNames()) {
    if (name.startsWith(VIEW_PREFIX)) await execTmuxFile('tmux', ['kill-session', '-t', name]).catch(() => {})
  }
}

test('attach frame schema keeps viewId instead of stripping it', () => {
  // zod 默认剥离未声明字段：白名单漏了 viewId 的话，路由层 parse 后永远收不到
  const parsed = streamAttachMessageSchema.parse({
    type: 'attach',
    sessionName: TEST_TMUX_SESSION,
    viewId: 'abcdefgh',
  })
  assert.equal(parsed.viewId, 'abcdefgh')
})

test('two view ids attach to independent hubs while every message keeps base sessionName', async (t) => {
  setupEnv()
  const spawns = setupPtySpawn()
  await resetBase()
  t.after(async () => {
    await cleanupOwn()
    teardownEnv()
  })
  const a = createSocket()
  const b = createSocket()
  const sa = new StreamSession(a.socket, null)
  const sb = new StreamSession(b.socket, null)
  const viewIdA = 'viewalpha01'
  const viewIdB = 'viewbeta002'
  const viewA = viewSessionName('local', TEST_TMUX_SESSION, viewIdA)
  const viewB = viewSessionName('local', TEST_TMUX_SESSION, viewIdB)

  await sa.attach({ hostId: 'local', sessionName: TEST_TMUX_SESSION, viewId: viewIdA, cols: 80, rows: 24 })
  await sb.attach({ hostId: 'local', sessionName: TEST_TMUX_SESSION, viewId: viewIdB, cols: 90, rows: 30 })

  // 每 view 一条 hub/PTY：同一 base 不再共享 current window
  assert.equal(spawns.length, 2, '每个 view 各起一条 PTY')
  assert.equal(countSharedTerminals(), 2)
  assert.equal(sa.sharedHub?.sessionName, viewA)
  assert.equal(sb.sharedHub?.sessionName, viewB)
  assert.notEqual(sa.sharedHub?.key, sb.sharedHub?.key)
  assert.equal(sa.attachedSessionName, TEST_TMUX_SESSION)
  assert.equal(sa.attachedViewName, viewA)

  // 归属 option 落盘
  const { stdout } = await execTmuxFile('tmux', [
    'list-sessions',
    '-F',
    '#{session_name}\t#{@tmuxgo_view_base}\t#{@tmuxgo_view_client}',
  ])
  assert.match(String(stdout), new RegExp(`${viewA}\t${TEST_TMUX_SESSION}\t${viewIdA}`))
  assert.match(String(stdout), new RegExp(`${viewB}\t${TEST_TMUX_SESSION}\t${viewIdB}`))

  // 对外协议只出现 base：attach 回执与输出帧都不许泄漏 view 名
  for (const socket of [a, b]) {
    const attached = socket.sent.find((message) => message.type === 'attached')
    assert.equal(attached?.sessionName, TEST_TMUX_SESSION)
  }
  spawns[0].emitData('hello-view-a')
  await sa.flushOutput()
  await sb.flushOutput()
  const output = a.sent.find((message) => message.type === 'output')
  assert.equal(output?.sessionName, TEST_TMUX_SESSION)
  assert.ok(!b.sent.some((message) => message.data?.includes('hello-view-a')), '不同 view 不共享输出')
  const leaked = [...a.frames, ...b.frames].join('\n')
  assert.ok(!leaked.includes(viewA) && !leaked.includes(viewB), 'view 名不得出现在对外帧里')
})

test('TMUXGO_VIEWS=0 ignores viewId and never creates a view', async (t) => {
  setupEnv()
  const spawns = setupPtySpawn()
  await resetBase()
  t.after(async () => {
    await cleanupOwn()
    teardownEnv()
  })
  process.env.TMUXGO_VIEWS = '0'
  const socket = createSocket()
  const session = new StreamSession(socket.socket, null)
  const viewId = 'viewdisabled1'
  await session.attach({ hostId: 'local', sessionName: TEST_TMUX_SESSION, viewId, cols: 80, rows: 24 })

  assert.equal(spawns.length, 1)
  assert.equal(session.attachedViewName, null)
  assert.equal(session.sharedHub?.key, sharedTerminalKey('local', TEST_TMUX_SESSION))
  assert.ok(!(await sessionNames()).includes(viewSessionName('local', TEST_TMUX_SESSION, viewId)))
})

test('invalid viewId is rejected through the attach error path without touching tmux', async (t) => {
  setupEnv()
  setupPtySpawn()
  await resetBase()
  t.after(async () => {
    await cleanupOwn()
    teardownEnv()
  })
  const socket = createSocket()
  const session = new StreamSession(socket.socket, null)
  for (const viewId of ['short', 'has space', 'x'.repeat(65), 42]) {
    await assert.rejects(
      session.attach({ hostId: 'local', sessionName: TEST_TMUX_SESSION, viewId, cols: 80, rows: 24 }),
      /Invalid viewId/,
    )
  }
  assert.equal(countSharedTerminals(), 0, '非法 viewId 不得回落 base 起 PTY')
  assert.deepEqual(
    (await sessionNames()).filter((name) => name.startsWith(VIEW_PREFIX)),
    [],
  )
})

test('same-name session without ownership options fails attach and is left intact', async (t) => {
  setupEnv()
  setupPtySpawn()
  await resetBase()
  t.after(async () => {
    await cleanupOwn()
    teardownEnv()
  })
  const viewId = 'viewcollide9'
  const name = viewSessionName('local', TEST_TMUX_SESSION, viewId)
  await execTmuxFile('tmux', ['new-session', '-d', '-s', name])
  const socket = createSocket()
  const session = new StreamSession(socket.socket, null)
  await assert.rejects(
    session.attach({ hostId: 'local', sessionName: TEST_TMUX_SESSION, viewId, cols: 80, rows: 24 }),
    /View session attach failed: View session collision/i,
  )
  assert.ok((await sessionNames()).includes(name), 'collision 目标绝不能被 kill')
  assert.equal(countSharedTerminals(), 0)
})

test('detached view survives cleanup and is only cleared by sweep after TTL', async (t) => {
  setupEnv()
  setupPtySpawn()
  await resetBase()
  t.after(async () => {
    await cleanupOwn()
    teardownEnv()
  })
  const viewId = 'viewdetach01'
  const view = viewSessionName('local', TEST_TMUX_SESSION, viewId)
  const socket = createSocket()
  const session = new StreamSession(socket.socket, null)
  await session.attach({ hostId: 'local', sessionName: TEST_TMUX_SESSION, viewId, cols: 80, rows: 24 })
  session.cleanup()
  assert.equal(countSharedTerminals(), 0, '宽限 0 时 hub 立即销毁')
  assert.ok((await sessionNames()).includes(view), 'detach 后 view 仍在，保住 current window')

  // TTL 未到：sweep 不动
  assert.deepEqual(await sweepViewSessions('local', { base: TEST_TMUX_SESSION, ttlMs: 60 * 60 * 1000 }), [])
  assert.ok((await sessionNames()).includes(view))
  // TTL 到了：交给 sweep，而不是 hub destroy 立刻杀
  assert.deepEqual(await sweepViewSessions('local', { base: TEST_TMUX_SESSION, ttlMs: 0 }), [view])
  assert.ok(!(await sessionNames()).includes(view))
})
