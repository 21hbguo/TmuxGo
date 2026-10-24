// 真 tmux 集成：验证「钉虚拟视口」确实改到了 tmux window 尺寸，且多 client 时
// 会主动跳过。只用隔离 server 上名为 test 的 session（test-tmux.ts 断言 TMUX_TMPDIR），
// 用真 node-pty 起 tmux attach 当 client。
import '../../test-env.js'
import '../../test-tmux.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import pty from 'node-pty'
import { createTerminalAttachment, setPtySpawnForTest } from '../terminal-attachment.js'
import {
  acquireSharedTerminal,
  pinHeadlessViewport,
  resetSharedTerminalsForTest,
  setCountAttachedClientsForTest,
  setHeadlessViewportForTest,
  setHubGraceMsForTest,
} from './shared-terminal.js'
import { TEST_TMUX_SESSION, execTmuxFile, killTestTmuxSession } from '../../test-tmux.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function readWindowSize() {
  const { stdout } = await execTmuxFile('tmux', [
    'display-message',
    '-p',
    '-t',
    TEST_TMUX_SESSION,
    '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}

async function waitForWindowSize(expected: string, timeoutMs = 4000) {
  const startedAt = Date.now()
  let last = ''
  while (Date.now() - startedAt < timeoutMs) {
    last = await readWindowSize()
    if (last === expected) return
    await sleep(50)
  }
  throw new Error(`window size did not settle to ${expected} (last ${last})`)
}

test('pinning resizes the real tmux window only while this hub is the only client', async (t) => {
  // 真 PTY：显式装回默认 spawn（本文件不 mock，写明意图防后来者以为漏了）
  setPtySpawnForTest((file, args, options) => pty.spawn(file, args, options))
  resetSharedTerminalsForTest()
  setHubGraceMsForTest(5000)
  setHeadlessViewportForTest({ cols: 120, rows: 40 })
  setCountAttachedClientsForTest(null)
  t.after(() => {
    setHubGraceMsForTest(null)
    setHeadlessViewportForTest(null)
    setCountAttachedClientsForTest(null)
    resetSharedTerminalsForTest()
  })
  await execTmuxFile('tmux', ['kill-session', '-t', TEST_TMUX_SESSION]).catch(() => {})
  await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '80', '-y', '24'])
  t.after(() => killTestTmuxSession())

  // 注意：钉的是「client 视口」尺寸，tmux 自己再扣掉 1 行状态栏才是 window 尺寸
  // （120x40 视口 → 120x39 window）。断言按 window 口径写，顺带把这条换算钉住。
  // 1) hub 自己的 attach client 就把 window 拉到 100x29
  const { hub } = await acquireSharedTerminal({
    hostId: 'local',
    sessionName: TEST_TMUX_SESSION,
    cols: 100,
    rows: 30,
  })
  await waitForWindowSize('100x29')

  // 2a) 没有订阅者：钉到虚拟视口，真 window 跟着变
  assert.equal(hub.subscribers.size, 0)
  assert.equal(await pinHeadlessViewport(hub), true)
  await waitForWindowSize('120x39')

  // 2b) 多一个 client：必须跳过，window 保持第二个 client 的尺寸
  const second = await createTerminalAttachment({
    hostId: 'local',
    sessionName: TEST_TMUX_SESSION,
    cols: 90,
    rows: 28,
    exclusive: true,
  })
  await waitForWindowSize('90x27')
  assert.equal(await pinHeadlessViewport(hub), false, 'session 上还有别的 client，不许改 window')
  await sleep(100)
  assert.equal(await readWindowSize(), '90x27')

  // 4) 第二个 client 走了：tmux 自己把 window 收回剩余 client（我们）的尺寸，
  //    不需要我们再动手——此时再钉是 no-op，返回 false 但尺寸本来就是对的目标
  second.kill()
  await waitForWindowSize('120x39')
  assert.equal(await pinHeadlessViewport(hub), false, '已经是目标尺寸就不该再碰 PTY')

  // 5) 跳过是可恢复的、不是永久降级：模拟新 client 按自己的 fit 改过 window 后又走了
  hub.resizePty(110, 34)
  await waitForWindowSize('110x33')
  assert.equal(await pinHeadlessViewport(hub), true)
  await waitForWindowSize('120x39')
})
