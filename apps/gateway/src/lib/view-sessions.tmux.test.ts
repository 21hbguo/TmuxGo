// 真 tmux 集成：grouped view 的创建/归属校验/清理。必须经根 `pnpm test` 跑
// （test-tmux.ts 断言隔离 server）；只操作隔离 server 上名为 test 的 base 与
// 本文件创建的前缀 session，绝不碰用户日常 tmux。
import '../test-env.js'
import '../test-tmux.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalAttachment } from './terminal-attachment.js'
import {
  VIEW_BASE_OPTION,
  VIEW_CLIENT_OPTION,
  VIEW_SESSION_PREFIX,
  ensureViewSession,
  killViewSession,
  sweepViewSessions,
  viewSessionName,
} from './view-sessions.js'
import { TEST_TMUX_SESSION, execTmuxFile, killTestTmuxSession } from '../test-tmux.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const tmux = (...args: string[]) => execTmuxFile('tmux', args)

async function sessionNames(): Promise<string[]> {
  const { stdout } = await tmux('list-sessions', '-F', '#{session_name}').catch(() => ({ stdout: '' }))
  return String(stdout).split('\n').filter(Boolean)
}

async function currentWindow(name: string): Promise<string> {
  const { stdout } = await tmux('display-message', '-p', '-t', name, '#{window_index}')
  return String(stdout).trim()
}

async function readOption(name: string, option: string): Promise<string> {
  const { stdout } = await tmux('show-options', '-qv', '-t', name, option).catch(() => ({ stdout: '' }))
  return String(stdout).trim()
}

async function windowFingerprint(name: string): Promise<string> {
  const { stdout } = await tmux('list-windows', '-t', name, '-F', '#{window_index}:#{window_name}:#{window_active}')
  return String(stdout).trim()
}

async function waitForAttached(name: string, expected: number, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now()
  let last = ''
  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = await tmux('display-message', '-p', '-t', name, '#{session_attached}').catch(() => ({
      stdout: '',
    }))
    last = String(stdout).trim()
    if (last === String(expected)) return
    await sleep(25)
  }
  throw new Error(`session_attached of ${name} did not settle to ${expected} (last ${last})`)
}

// 清掉本文件自己创建的东西：base test + tmuxgo-view-* 前缀 session。
// 隔离 server 上只剩测试会话，但仍按前缀收敛，避免误伤别的用例
async function cleanupOwnSessions() {
  await killTestTmuxSession()
  for (const name of await sessionNames()) {
    if (name.startsWith(VIEW_SESSION_PREFIX)) await tmux('kill-session', '-t', name).catch(() => {})
  }
}

async function resetBase() {
  await cleanupOwnSessions()
  await tmux('new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '80', '-y', '24')
}

test('ensureViewSession is idempotent, records options and inherits base current window', async (t) => {
  t.after(cleanupOwnSessions)
  await resetBase()
  const firstWindow = await currentWindow(TEST_TMUX_SESSION)
  await tmux('new-window', '-t', TEST_TMUX_SESSION)
  const activeWindow = await currentWindow(TEST_TMUX_SESSION)
  assert.notEqual(activeWindow, firstWindow, 'base 必须停在一个非初始窗口，才能验证继承')

  const viewId = 'viewalign01'
  const expected = viewSessionName('local', TEST_TMUX_SESSION, viewId)
  const created = await ensureViewSession('local', TEST_TMUX_SESSION, viewId)
  assert.equal(created, expected)
  // 幂等：第二次不新建、不报错
  assert.equal(await ensureViewSession('local', TEST_TMUX_SESSION, viewId), expected)
  assert.equal((await sessionNames()).filter((name) => name === expected).length, 1)

  assert.equal(await readOption(expected, VIEW_BASE_OPTION), TEST_TMUX_SESSION)
  assert.equal(await readOption(expected, VIEW_CLIENT_OPTION), viewId)
  // 实测 tmux 3.4：new-session -t base 建出的 grouped session 停在窗口表第一项，
  // 不继承 base 的 current window；ensure 必须 select-window 对齐
  assert.equal(await currentWindow(expected), activeWindow)
})

test('a same-name session without ownership options is a collision and is never killed', async (t) => {
  t.after(cleanupOwnSessions)
  await resetBase()
  const viewId = 'viewcollide1'
  const name = viewSessionName('local', TEST_TMUX_SESSION, viewId)
  // 用户自己建的同名 session：没有 @tmuxgo_view_base，必须按 collision 报错
  await tmux('new-session', '-d', '-s', name)
  await assert.rejects(ensureViewSession('local', TEST_TMUX_SESSION, viewId), /View session collision/i)
  assert.ok((await sessionNames()).includes(name), 'collision 目标绝不能被 kill')
  assert.equal(await readOption(name, VIEW_BASE_OPTION), '')

  // option 指向别的 base 同样算 collision
  await tmux('set-option', '-t', name, VIEW_BASE_OPTION, 'some-other-base')
  await tmux('set-option', '-t', name, VIEW_CLIENT_OPTION, viewId)
  await assert.rejects(ensureViewSession('local', TEST_TMUX_SESSION, viewId), /View session collision/i)
  assert.ok((await sessionNames()).includes(name))
})

test('killViewSession removes only the owned view, never base/windows/plain sessions', async (t) => {
  t.after(cleanupOwnSessions)
  await resetBase()
  await tmux('new-window', '-t', TEST_TMUX_SESSION)
  const viewId = 'viewkill0001'
  const view = await ensureViewSession('local', TEST_TMUX_SESSION, viewId)
  const baseWindows = await windowFingerprint(TEST_TMUX_SESSION)

  assert.equal(await killViewSession('local', view, TEST_TMUX_SESSION), true)
  assert.ok(!(await sessionNames()).includes(view), 'view 应被删除')
  assert.ok((await sessionNames()).includes(TEST_TMUX_SESSION), 'base 必须保留')
  assert.equal(await windowFingerprint(TEST_TMUX_SESSION), baseWindows, 'base 的 window 列表/活动项不受影响')
  // 幂等：已消失返回 false
  assert.equal(await killViewSession('local', view, TEST_TMUX_SESSION), false)

  // 没有归属 option 的普通 session 永远不动
  const plain = 'plain-guard'
  await tmux('new-session', '-d', '-s', plain)
  assert.equal(await killViewSession('local', plain), false)
  assert.ok((await sessionNames()).includes(plain))
})

test('sweepViewSessions keeps attached views and only clears detached ones past TTL', async (t) => {
  t.after(cleanupOwnSessions)
  await resetBase()
  const idleViewId = 'viewidle0001'
  const attachedViewId = 'viewattach1'
  const idleView = await ensureViewSession('local', TEST_TMUX_SESSION, idleViewId)
  const attachedView = await ensureViewSession('local', TEST_TMUX_SESSION, attachedViewId)

  // TTL 未到：空闲 view 不动
  assert.deepEqual(await sweepViewSessions('local', { base: TEST_TMUX_SESSION, ttlMs: 60 * 60 * 1000 }), [])
  assert.ok((await sessionNames()).includes(idleView))

  // 真 client 附着到另一个 view：即使 TTL=0 也不能清
  const client = await createTerminalAttachment({
    hostId: 'local',
    sessionName: attachedView,
    cols: 80,
    rows: 24,
    exclusive: true,
  })
  try {
    await waitForAttached(attachedView, 1)
    const killed = await sweepViewSessions('local', { base: TEST_TMUX_SESSION, ttlMs: 0 })
    assert.deepEqual(killed, [idleView], '只清空闲 view，attached view 不动')
    assert.ok((await sessionNames()).includes(attachedView))
    assert.ok(!(await sessionNames()).includes(idleView))
  } finally {
    client.kill()
  }
  // detach 之后 view 仍保留（不靠 destroy 立刻杀），TTL 到了才由 sweep 清
  await waitForAttached(attachedView, 0)
  assert.ok((await sessionNames()).includes(attachedView), 'detach 后 view 仍在，等 TTL 清扫')
  assert.deepEqual(await sweepViewSessions('local', { base: TEST_TMUX_SESSION, ttlMs: 0 }), [attachedView])
  assert.ok(!(await sessionNames()).includes(attachedView))
})

test('sweepViewSessions clears orphan views whose base no longer exists', async (t) => {
  t.after(cleanupOwnSessions)
  await resetBase()
  const viewId = 'vieworphan01'
  const view = await ensureViewSession('local', TEST_TMUX_SESSION, viewId)
  await tmux('kill-session', '-t', TEST_TMUX_SESSION)
  // grouped session 在 base 被杀后仍持有共享 window（实测 tmux 3.4）：孤儿必须靠 sweep 收
  assert.ok((await sessionNames()).includes(view), 'base 消失后 view 会存活成孤儿')

  // 即便 activity 很新、TTL 设成 1 小时，base 不存在也要立即清
  assert.deepEqual(await sweepViewSessions('local', { base: TEST_TMUX_SESSION, ttlMs: 60 * 60 * 1000 }), [view])
  assert.ok(!(await sessionNames()).includes(view))
})
