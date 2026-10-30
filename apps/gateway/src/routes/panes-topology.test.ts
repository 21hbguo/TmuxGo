import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { flushAuditWrites, readAuditEvents } from '../lib/audit-log.js'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { paneRoutes } from './panes.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）。
// 拓扑动作（join/break/swap）会改 window 结构，所以每个用例都从干净 session 起。
interface PaneRow {
  windowId: string
  paneId: string
  index: number
}

async function tmux(...args: string[]) {
  const { stdout } = await execTmuxFile('tmux', args)
  return stdout.trim()
}

// sessionWide=true 走 list-panes -s：break/move 之后目标窗口不一定是 current window，
// 只看当前窗口会漏掉被搬走的 pane
async function paneRows(target: string, sessionWide = false): Promise<PaneRow[]> {
  const stdout = await tmux(
    'list-panes',
    ...(sessionWide ? ['-s'] : []),
    '-t',
    target,
    '-F',
    '#{window_id}\t#{pane_id}\t#{pane_index}',
  )
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowId, paneId, index] = line.split('\t')
      return { windowId, paneId, index: Number(index) }
    })
}

async function windowRows() {
  const stdout = await tmux('list-windows', '-t', TEST_TMUX_SESSION, '-F', '#{window_id}\t#{window_name}')
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowId, name] = line.split('\t')
      return { windowId, name }
    })
}

async function buildApp() {
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  return fastify
}

test('moves a pane into another window and records the audit target', async () => {
  const fastify = await buildApp()
  try {
    await killTestTmuxSession()
    await tmux('new-session', '-d', '-s', TEST_TMUX_SESSION, '-n', 'topo-a', '-x', '120', '-y', '40')
    const [staying] = await paneRows(`${TEST_TMUX_SESSION}:topo-a`)
    await tmux('split-window', '-t', `${TEST_TMUX_SESSION}:topo-a`, '-h')
    await tmux('new-window', '-t', `${TEST_TMUX_SESSION}:`, '-n', 'topo-b')
    const windows = await windowRows()
    const windowA = windows.find((item) => item.name === 'topo-a')?.windowId || ''
    const windowB = windows.find((item) => item.name === 'topo-b')?.windowId || ''
    assert.ok(windowA && windowB)
    const panesA = await paneRows(windowA)
    assert.equal(panesA.length, 2)
    const moving = panesA.find((item) => item.paneId !== staying.paneId)?.paneId || ''
    assert.ok(moving)

    const paneId = `local:${moving}`
    const targetWindowId = `local:${windowB}`
    const response = await fastify.inject({ method: 'POST', url: '/panes/move', payload: { paneId, targetWindowId } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, paneId, hostId: 'local' })

    // 源窗口少一个 pane，目标窗口多一个，且搬过去的是原 pane id
    assert.deepEqual(
      (await paneRows(windowA)).map((item) => item.paneId),
      [staying.paneId],
    )
    const panesB = await paneRows(windowB)
    assert.equal(panesB.length, 2)
    assert.ok(panesB.some((item) => item.paneId === moving))

    // 审计：成功也记，target 为 <src>→<dst>
    await flushAuditWrites()
    const events = await readAuditEvents({ action: 'pane-move', result: 'success', limit: 50 })
    const event = events.find((item) => item.target === `${paneId}→${targetWindowId}`)
    assert.ok(event, 'pane-move 成功审计应存在')
    assert.equal(event.hostId, 'local')
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('breaks a pane out into a new window', async () => {
  const fastify = await buildApp()
  try {
    await killTestTmuxSession()
    await tmux('new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '120', '-y', '40')
    const [staying] = await paneRows(TEST_TMUX_SESSION)
    await tmux('split-window', '-t', staying.paneId, '-h')
    assert.equal((await windowRows()).length, 1)
    const panes = await paneRows(TEST_TMUX_SESSION)
    const detached = panes.find((item) => item.paneId !== staying.paneId)
    assert.ok(detached)

    const paneId = `local:${detached.paneId}`
    const response = await fastify.inject({
      method: 'POST',
      url: '/panes/break',
      payload: { paneId, name: 'topo-break' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, paneId, hostId: 'local' })

    const windows = await windowRows()
    assert.equal(windows.length, 2)
    assert.ok(
      windows.some((item) => item.name === 'topo-break'),
      'break-pane -n 应给新窗口命名',
    )
    const relisted = await paneRows(TEST_TMUX_SESSION, true)
    const moved = relisted.find((item) => item.paneId === detached.paneId)
    assert.ok(moved)
    assert.notEqual(moved.windowId, staying.windowId)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('swaps two panes so their positions exchange', async () => {
  const fastify = await buildApp()
  try {
    await killTestTmuxSession()
    await tmux('new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '120', '-y', '40')
    const [original] = await paneRows(TEST_TMUX_SESSION)
    await tmux('split-window', '-t', original.paneId, '-h')
    const panes = await paneRows(TEST_TMUX_SESSION)
    assert.equal(panes.length, 2)
    const [left, right] = panes
    assert.notEqual(left.index, right.index)

    const paneId = `local:${left.paneId}`
    const targetPaneId = `local:${right.paneId}`
    const response = await fastify.inject({ method: 'POST', url: '/panes/swap', payload: { paneId, targetPaneId } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, paneId, hostId: 'local', targetPaneId })

    // pane_index 即窗口内位置：互换后两个 pane id 应该占住对方原来的 index
    const swapped = await paneRows(TEST_TMUX_SESSION)
    assert.equal(swapped.find((item) => item.index === left.index)?.paneId, right.paneId)
    assert.equal(swapped.find((item) => item.index === right.index)?.paneId, left.paneId)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('rejects invalid topology requests with 400 and audits failures', async () => {
  const fastify = await buildApp()
  try {
    // 这些用例都在触 tmux 之前就被拒（纯逻辑校验或 zod），所以不需要真 session
    const cases: Array<{ url: string; payload: Record<string, unknown>; reason: string }> = [
      {
        url: '/panes/move',
        payload: { paneId: 'local:%1', targetPaneId: 'remote:%2' },
        reason: '跨 host 的 target pane',
      },
      {
        url: '/panes/move',
        payload: { paneId: 'local:%1', targetWindowId: 'remote:@2' },
        reason: '跨 host 的 target window',
      },
      { url: '/panes/move', payload: { paneId: 'local:%1', targetPaneId: 'local:%1' }, reason: '源与目标同一 pane' },
      { url: '/panes/move', payload: { paneId: 'local:%1' }, reason: '两个 target 都没给' },
      {
        url: '/panes/move',
        payload: { paneId: 'local:%1', targetWindowId: 'local:@2', targetPaneId: 'local:%2' },
        reason: '两个 target 同时给',
      },
      {
        url: '/panes/move',
        payload: { paneId: 'local:%1', targetWindowId: 'local:@2', sizePercent: 5 },
        reason: 'sizePercent 越界',
      },
      { url: '/panes/break', payload: { paneId: 'local:%1', name: 'bad\nname' }, reason: '窗口名含控制字符' },
      { url: '/panes/swap', payload: { paneId: 'local:%1', targetPaneId: 'local:%1' }, reason: 'swap 到自身' },
      { url: '/panes/swap', payload: { paneId: 'local:%1', targetPaneId: 'remote:%2' }, reason: 'swap 跨 host' },
    ]
    for (const item of cases) {
      const response = await fastify.inject({ method: 'POST', url: item.url, payload: item.payload })
      assert.equal(response.statusCode, 400, item.reason)
      const body = response.json() as { ok: boolean; error?: string }
      assert.equal(body.ok, false, item.reason)
      assert.equal(typeof body.error, 'string', item.reason)
      assert.ok(body.error, item.reason)
    }

    // 失败也进审计：三个 action 都应该出现 failure 记录
    await flushAuditWrites()
    const failures = await readAuditEvents({ result: 'failure', limit: 100 })
    const actions = new Set(failures.map((item) => item.action))
    assert.ok(actions.has('pane-move'), 'pane-move 失败审计应存在')
    assert.ok(actions.has('pane-break'), 'pane-break 失败审计应存在')
    assert.ok(actions.has('pane-swap'), 'pane-swap 失败审计应存在')
  } finally {
    await fastify.close()
  }
})
