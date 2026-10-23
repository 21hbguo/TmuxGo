import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { MAX_SYNC_PANES, clearSyncMembers, fanOutSyncInput, readSyncMembers, replaceSyncMembers } from './sync-panes.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function startSessionWithTwoPanes() {
  await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '120', '-y', '40'])
  await execTmuxFile('tmux', ['split-window', '-t', TEST_TMUX_SESSION, '-h'])
  const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', TEST_TMUX_SESSION, '-F', '#{pane_id}'])
  const [first, second] = stdout.trim().split('\n')
  return { first: `local:${first}`, second: `local:${second}`, tmuxFirst: first, tmuxSecond: second }
}

async function capturePane(tmuxPaneId: string) {
  const { stdout } = await execTmuxFile('tmux', ['capture-pane', '-p', '-t', tmuxPaneId])
  return stdout
}

// 广播落点要等 shell 把回显画出来：轮询 capture-pane 到超时，避免定长 sleep 造成的偶发
async function waitForPaneText(tmuxPaneId: string, text: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await capturePane(tmuxPaneId)).includes(text)) return true
    await wait(50)
  }
  return false
}

test('broadcasts input to the other members of the group', async () => {
  try {
    const { first, second, tmuxFirst, tmuxSecond } = await startSessionWithTwoPanes()
    await replaceSyncMembers([
      { paneId: first, sessionName: TEST_TMUX_SESSION },
      { paneId: second, sessionName: TEST_TMUX_SESSION },
    ])
    await fanOutSyncInput({ data: 'echo SYNC-BROADCAST-OK\r', sourcePaneId: first })
    assert.equal(await waitForPaneText(tmuxSecond, 'SYNC-BROADCAST-OK'), true, 'member pane 应收到广播输入')
    // 发起 pane 不重复投递（它的输入已由 pty 送出，再发一次会有双份字符）
    assert.equal((await capturePane(tmuxFirst)).includes('SYNC-BROADCAST-OK'), false, '发起 pane 不应被重复投递')
  } finally {
    await clearSyncMembers()
    await killTestTmuxSession()
  }
})

test('skips panes outside the caller scope and prunes panes that no longer exist', async () => {
  try {
    const { first, second } = await startSessionWithTwoPanes()
    await replaceSyncMembers([
      { paneId: first, sessionName: TEST_TMUX_SESSION },
      { paneId: 'remote-host:%2', sessionName: TEST_TMUX_SESSION },
      { paneId: 'local:%999999', sessionName: TEST_TMUX_SESSION },
    ])
    // scope 只允许 local：越权 host 一律跳过，且不能因为跳过就报错中断整次广播
    const result = await fanOutSyncInput({
      data: 'x',
      sourcePaneId: second,
      scope: { hosts: ['local'], sessions: [TEST_TMUX_SESSION] },
    })
    assert.equal(result.delivered, 1)
    // 越权 host 1 个 + 不存在的 pane 1 个
    assert.equal(result.skipped, 2)
    // 不存在的 pane 会被剔出组，避免每次击键都白跑一次 send-keys。
    // 剔除是异步落盘的（不能挡住击键），所以这里轮询等它生效
    assert.equal(result.pruned, 1)
    let members = await readSyncMembers()
    const deadline = Date.now() + 2000
    while (members.some((member) => member.paneId === 'local:%999999') && Date.now() < deadline) {
      await wait(20)
      members = await readSyncMembers()
    }
    assert.deepEqual(members.map((member) => member.paneId).sort(), [first, 'remote-host:%2'].sort())
  } finally {
    await clearSyncMembers()
    await killTestTmuxSession()
  }
})

test('ignores frames without a source pane and oversized payloads', async () => {
  await replaceSyncMembers([
    { paneId: 'local:%11', sessionName: 'test' },
    { paneId: 'local:%12', sessionName: 'test' },
  ])
  try {
    // 老客户端只发会话级 input：认不出具体 pane，宁可不广播也不要猜错重复投递
    assert.deepEqual(await fanOutSyncInput({ data: 'x' }), { delivered: 0, skipped: 0, pruned: 0 })
    // 超大块应走 paste-data 通道，混入广播会撞命令行长度上限
    assert.deepEqual(await fanOutSyncInput({ data: 'x'.repeat(5000), sourcePaneId: 'local:%11' }), {
      delivered: 0,
      skipped: 0,
      pruned: 0,
    })
  } finally {
    await clearSyncMembers()
  }
})

test('dedupes members and caps the group size', async () => {
  try {
    const many = Array.from({ length: MAX_SYNC_PANES + 5 }, (_, index) => ({
      paneId: `local:%${index + 1}`,
      sessionName: 'test',
    }))
    const saved = await replaceSyncMembers([...many, many[0]])
    assert.equal(saved.length, MAX_SYNC_PANES)
    assert.equal(new Set(saved.map((member) => member.paneId)).size, MAX_SYNC_PANES)
    // 热路径读的是内存缓存：写完立刻读到同一份
    assert.deepEqual(await readSyncMembers(), saved)
  } finally {
    await clearSyncMembers()
  }
})
