import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test, { type TestContext } from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { VIEW_BASE_OPTION, VIEW_CLIENT_OPTION, viewSessionName } from '../lib/view-sessions.js'
import { windowRoutes } from './windows.js'

// 契约归位：解析失败 / 跨 host 引用 → 400 INVALID_REQUEST；tmux 缺目标、未知 host → 404 *_NOT_FOUND。
// 归位前这些分支裸抛，被 fastify 兜成 500 + tmux 英文原文。
async function buildApp(t: TestContext) {
  const app = Fastify()
  await app.register(windowRoutes)
  t.after(() => app.close())
  return app
}

async function errorOf(app: Awaited<ReturnType<typeof buildApp>>, url: string, payload?: Record<string, unknown>) {
  const response = await app.inject(payload === undefined ? { method: 'GET', url } : { method: 'POST', url, payload })
  return { status: response.statusCode, body: response.json() as { message: string; code: string } }
}

test('window routes reject a malformed session id with 400 instead of 500', async (t) => {
  const app = await buildApp(t)
  const { status, body } = await errorOf(app, '/hosts/local/sessions/%20/windows')
  assert.equal(status, 400)
  // message 保留原文供 toast 展示，code 供客户端分支；两者都不再是 fastify 默认体
  assert.deepEqual(body, { message: 'Invalid session id', code: 'INVALID_REQUEST' })
})

test('window mutations reject foreign or malformed windowId with 400', async (t) => {
  const app = await buildApp(t)
  const foreign = await errorOf(app, '/hosts/local/sessions/session-local-x/windows/select', {
    windowId: 'devbox:@1',
  })
  assert.equal(foreign.status, 400)
  assert.deepEqual(foreign.body, { message: 'Window does not belong to host', code: 'INVALID_REQUEST' })

  for (const action of ['select', 'rename', 'kill']) {
    const malformed = await errorOf(app, `/hosts/local/sessions/session-local-x/windows/${action}`, {
      windowId: 'local:nope',
      name: 'n',
    })
    assert.equal(malformed.status, 400, action)
    assert.deepEqual(malformed.body, { message: 'Invalid window id', code: 'INVALID_REQUEST' })
  }
})

test('window move rejects a missing order and a foreign windowId with 400', async (t) => {
  const app = await buildApp(t)
  const empty = await errorOf(app, '/hosts/local/sessions/session-local-x/windows/move', { orderedWindowIds: [] })
  assert.equal(empty.status, 400)
  assert.deepEqual(empty.body, { message: 'orderedWindowIds is required', code: 'INVALID_REQUEST' })

  const foreign = await errorOf(app, '/hosts/local/sessions/session-local-x/windows/move', {
    orderedWindowIds: ['devbox:@1'],
  })
  assert.equal(foreign.status, 400)
  assert.deepEqual(foreign.body, { message: 'Window does not belong to host', code: 'INVALID_REQUEST' })
})

test('window/pane route params reject malformed ids with 400', async (t) => {
  const app = await buildApp(t)
  for (const url of ['/windows/local/panes', '/windows/local:win/panes']) {
    const { status, body } = await errorOf(app, url)
    assert.equal(status, 400, url)
    assert.deepEqual(body, { message: 'Invalid window id', code: 'INVALID_REQUEST' })
  }
  const split = await errorOf(app, '/windows/local/panes', { direction: 'vertical' })
  assert.equal(split.status, 400)
  assert.deepEqual(split.body, { message: 'Invalid window id', code: 'INVALID_REQUEST' })

  const output = await errorOf(app, '/panes/local:1/output')
  assert.equal(output.status, 400)
  assert.deepEqual(output.body, { message: 'Invalid pane id', code: 'INVALID_REQUEST' })
})

test('unknown host resolves to 404 HOST_NOT_FOUND', async (t) => {
  const app = await buildApp(t)
  const { status, body } = await errorOf(app, '/hosts/ghost/sessions/session-ghost-x/windows')
  assert.equal(status, 404)
  assert.equal(body.code, 'HOST_NOT_FOUND')
  // tmux 通道路由的原文保留在 message 里
  assert.match(body.message, /Host "ghost" not found/)
})

test('missing session/window/pane resolve to 404 with the tmux message kept', async (t) => {
  const app = await buildApp(t)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION])
    const sessionId = `session-local-${TEST_TMUX_SESSION}`

    const ghostSession = await errorOf(app, '/hosts/local/sessions/session-local-ghost/windows')
    assert.equal(ghostSession.status, 404)
    assert.equal(ghostSession.body.code, 'SESSION_NOT_FOUND')
    assert.match(ghostSession.body.message, /can't find|no such|not found/i)

    // 真实 session 上探店不存在的 window/pane：tmux 原文进 message，状态码归 404
    const ghostWindow = await errorOf(app, `/hosts/local/sessions/${sessionId}/windows/kill`, {
      windowId: 'local:@999',
    })
    assert.equal(ghostWindow.status, 404)
    assert.equal(ghostWindow.body.code, 'WINDOW_NOT_FOUND')

    const ghostPane = await errorOf(app, '/panes/local:%25999/output')
    assert.equal(ghostPane.status, 404)
    assert.equal(ghostPane.body.code, 'PANE_NOT_FOUND')
  } finally {
    await killTestTmuxSession()
  }
})

test('successful window lifecycle keeps the 200 {ok:true,windows} contract', async (t) => {
  const app = await buildApp(t)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION])
    const sessionId = `session-local-${TEST_TMUX_SESSION}`
    const created = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${sessionId}/windows`,
      payload: { name: 'contract2' },
    })
    assert.equal(created.statusCode, 200)
    const window = created.json() as { id: string; name: string }
    assert.equal(window.name, 'contract2')

    const renamed = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${sessionId}/windows/rename`,
      payload: { windowId: window.id, name: 'renamed' },
    })
    assert.equal(renamed.statusCode, 200)
    const renamedBody = renamed.json() as { ok: boolean; windows: { id: string; name: string }[] }
    assert.equal(renamedBody.ok, true)
    assert.equal(renamedBody.windows.find((item) => item.id === window.id)?.name, 'renamed')

    const killed = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${sessionId}/windows/kill`,
      payload: { windowId: window.id },
    })
    assert.equal(killed.statusCode, 200)
    const killedBody = killed.json() as { ok: boolean; windows: { id: string }[] }
    assert.equal(killedBody.ok, true)
    assert.equal(
      killedBody.windows.some((item) => item.id === window.id),
      false,
    )
  } finally {
    await killTestTmuxSession()
  }
})

test('session pane list carries windowIndex so the client can rebuild the window tree', async (t) => {
  const app = await buildApp(t)
  try {
    // 前一个用例可能留下同名 session；显式清干净，别让残留 window 混进断言
    await killTestTmuxSession()
    await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION, '-n', 'first'])
    await execTmuxFile('tmux', ['new-window', '-t', `${TEST_TMUX_SESSION}:`, '-n', 'second'])
    await execTmuxFile('tmux', ['split-window', '-t', `${TEST_TMUX_SESSION}:second`, '-h'])
    const response = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/session-local-${TEST_TMUX_SESSION}/panes`,
    })
    assert.equal(response.statusCode, 200)
    const panes = response.json() as Array<{ windowName: string; windowIndex: number; index: number }>
    assert.equal(panes.length, 3)
    assert.equal(
      panes.every((pane) => typeof pane.windowIndex === 'number' && Number.isFinite(pane.windowIndex)),
      true,
    )
    // 输出顺序 = tmux list-panes -s 的 window → pane 顺序；前端靠 windowIndex 在合并冷数据后还原它
    const order = panes.map((pane) => pane.windowIndex * 100 + pane.index)
    assert.deepEqual(
      order,
      [...order].sort((left, right) => left - right),
    )
    const second = panes.filter((pane) => pane.windowName === 'second')
    assert.equal(second.length, 2)
    // 不断言从 0 起：宿主 base-pane-index/base-index 可能是 1，只要求窗口内递增且连续
    assert.deepEqual(
      second.map((pane) => pane.index),
      [...second.map((pane) => pane.index)].sort((left, right) => left - right),
    )
    assert.equal(second[1].index, second[0].index + 1)
    assert.equal(new Set(second.map((pane) => pane.windowIndex)).size, 1)
    const first = panes.filter((pane) => pane.windowName === 'first')
    assert.equal(first.length, 1)
    assert.notEqual(first[0].windowIndex, second[0].windowIndex)
  } finally {
    await killTestTmuxSession()
  }
})

// ── grouped view session：读路径与 select 的真 tmux 用例 ────────────────────
// view 名必须由 view-sessions.ts 统一生成；测试里也走同一个函数，避免手拼哈希。
interface TestWindow {
  id: string
  name: string
  index: number
}
async function tmux(args: string[]) {
  return execTmuxFile('tmux', args)
}
async function killSession(name: string) {
  await tmux(['kill-session', '-t', `=${name}`]).catch(() => {})
}
async function setupBaseWithTwoWindows() {
  await killTestTmuxSession()
  await tmux(['new-session', '-d', '-s', TEST_TMUX_SESSION, '-n', 'first'])
  await tmux(['new-window', '-t', `${TEST_TMUX_SESSION}:`, '-n', 'second'])
  const { stdout } = await tmux([
    'list-windows',
    '-t',
    TEST_TMUX_SESSION,
    '-F',
    '#{window_name}|#{window_index}|#{window_id}',
  ])
  const windows = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): TestWindow => {
      const [name, index, windowId] = line.split('|')
      return { id: `local:${windowId}`, name, index: parseInt(index, 10) }
    })
  const first = windows.find((window) => window.name === 'first')
  const second = windows.find((window) => window.name === 'second')
  assert.ok(first && second)
  return { first, second }
}
async function createGroupedView(base: string, viewId: string) {
  const name = viewSessionName('local', base, viewId)
  // 上一轮失败可能留下同名 view；先清掉，避免 duplicate session
  await killSession(name)
  await tmux(['new-session', '-d', '-t', base, '-s', name])
  await tmux(['set-option', '-t', name, VIEW_BASE_OPTION, base])
  await tmux(['set-option', '-t', name, VIEW_CLIENT_OPTION, viewId])
  return name
}
async function currentWindowId(sessionName: string) {
  const { stdout } = await tmux(['display-message', '-p', '-t', sessionName, '#{window_id}'])
  return stdout.trim()
}

test('GET windows/snapshot accept viewId: active from view, identity from base', async (t) => {
  const app = await buildApp(t)
  const viewId = 'readview0001'
  let viewName = ''
  try {
    const { first, second } = await setupBaseWithTwoWindows()
    viewName = await createGroupedView(TEST_TMUX_SESSION, viewId)
    // 刻意让两条 current 分开：base=second，view=first
    await tmux(['select-window', '-t', `${TEST_TMUX_SESSION}:${second.index}`])
    await tmux(['select-window', '-t', `${viewName}:${first.index}`])
    const baseSessionId = `session-local-${TEST_TMUX_SESSION}`

    const viewWindowsResponse = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/windows?viewId=${viewId}`,
    })
    assert.equal(viewWindowsResponse.statusCode, 200, viewWindowsResponse.body)
    const viewWindows = viewWindowsResponse.json() as {
      id: string
      sessionId: string
      name: string
      active: boolean
    }[]
    // active 标记来自 view，但 sessionId 必须仍是 base（前端按 activeSessionId 过滤）
    assert.equal(
      viewWindows.every((window) => window.sessionId === baseSessionId),
      true,
    )
    assert.equal(viewWindows.filter((window) => window.active).length, 1)
    assert.equal(viewWindows.find((window) => window.active)?.id, first.id)

    const baseWindowsResponse = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/windows`,
    })
    assert.equal(baseWindowsResponse.statusCode, 200)
    const baseWindows = baseWindowsResponse.json() as { id: string; sessionId: string; active: boolean }[]
    assert.equal(
      baseWindows.every((window) => window.sessionId === baseSessionId),
      true,
    )
    assert.equal(baseWindows.find((window) => window.active)?.id, second.id)

    const viewSnapshotResponse = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/snapshot?viewId=${viewId}`,
    })
    assert.equal(viewSnapshotResponse.statusCode, 200, viewSnapshotResponse.body)
    const viewSnapshot = viewSnapshotResponse.json() as {
      sessionId: string
      sessionName: string
      activeWindowId: string
      activePaneId: string | null
      panes: { id: string; windowId: string }[]
    }
    assert.equal(viewSnapshot.sessionId, baseSessionId)
    assert.equal(viewSnapshot.sessionName, TEST_TMUX_SESSION)
    assert.equal(viewSnapshot.activeWindowId, first.id)
    assert.equal(viewSnapshot.panes.find((pane) => pane.id === viewSnapshot.activePaneId)?.windowId, first.id)

    const baseSnapshotResponse = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/snapshot`,
    })
    assert.equal(baseSnapshotResponse.statusCode, 200)
    const baseSnapshot = baseSnapshotResponse.json() as { sessionId: string; activeWindowId: string }
    assert.equal(baseSnapshot.sessionId, baseSessionId)
    assert.equal(baseSnapshot.activeWindowId, second.id)

    const viewPanesResponse = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/panes?viewId=${viewId}`,
    })
    assert.equal(viewPanesResponse.statusCode, 200, viewPanesResponse.body)
    const viewPanes = viewPanesResponse.json() as { windowId: string }[]
    assert.equal(viewPanes.length, 2)
    assert.deepEqual(new Set(viewPanes.map((pane) => pane.windowId)), new Set([first.id, second.id]))
  } finally {
    if (viewName) await killSession(viewName)
    await killTestTmuxSession()
  }
})

test('select with viewId moves only that view current and keeps base current', async (t) => {
  const app = await buildApp(t)
  const viewId = 'selectview0001'
  let viewName = ''
  try {
    const { second } = await setupBaseWithTwoWindows()
    // 非连续 index 一并覆盖：grouped view 也必须按实际 index 精确切
    await tmux(['new-window', '-d', '-t', `${TEST_TMUX_SESSION}:7`, '-n', 'far'])
    const { stdout: farRow } = await tmux([
      'list-windows',
      '-t',
      TEST_TMUX_SESSION,
      '-F',
      '#{window_name}|#{window_id}',
    ])
    const farWindowId = farRow
      .split('\n')
      .find((line) => line.startsWith('far|'))
      ?.split('|')[1]
    assert.ok(farWindowId)
    const far = { id: `local:${farWindowId}`, name: 'far' }
    viewName = await createGroupedView(TEST_TMUX_SESSION, viewId)
    // base 和 view 都停在 second；目标切到 far，才有可观测变化
    await tmux(['select-window', '-t', `${TEST_TMUX_SESSION}:${second.index}`])
    await tmux(['select-window', '-t', `${viewName}:${second.index}`])
    const baseSessionId = `session-local-${TEST_TMUX_SESSION}`

    const response = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${baseSessionId}/windows/select`,
      payload: { windowId: far.id, viewId },
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as {
      ok: boolean
      windows: { id: string; sessionId: string; active: boolean; name: string }[]
    }
    assert.equal(body.ok, true)
    assert.equal(
      body.windows.every((window) => window.sessionId === baseSessionId),
      true,
    )
    assert.equal(body.windows.find((window) => window.active)?.id, far.id)
    assert.equal(body.windows.find((window) => window.active)?.name, 'far')

    // tmux 侧硬断言：view 的 current 变了，base 的 current 没动
    assert.equal(await currentWindowId(viewName), farWindowId)
    assert.equal(await currentWindowId(TEST_TMUX_SESSION), second.id.slice('local:'.length))

    const readBack = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/windows?viewId=${viewId}`,
    })
    assert.equal(readBack.statusCode, 200)
    assert.equal((readBack.json() as { id: string; active: boolean }[]).find((window) => window.active)?.id, far.id)
  } finally {
    if (viewName) await killSession(viewName)
    await killTestTmuxSession()
  }
})

test('viewId before the view session exists: reads fall back to base, select ensures the view', async (t) => {
  const app = await buildApp(t)
  const baseSessionId = `session-local-${TEST_TMUX_SESSION}`
  const viewId = 'missingview0001'
  try {
    const { first, second } = await setupBaseWithTwoWindows()
    // attach 建 view 之前，首屏读已经带着 viewId 到达：必须回退 base，不能 404
    await tmux(['select-window', '-t', `${TEST_TMUX_SESSION}:${second.index}`])
    await killSession(viewSessionName('local', TEST_TMUX_SESSION, viewId))

    const windows = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/windows?viewId=${viewId}`,
    })
    assert.equal(windows.statusCode, 200, windows.body)
    const windowRows = windows.json() as { id: string; sessionId: string; active: boolean }[]
    assert.equal(
      windowRows.every((window) => window.sessionId === baseSessionId),
      true,
    )
    assert.equal(windowRows.find((window) => window.active)?.id, second.id)

    const snapshot = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/snapshot?viewId=${viewId}`,
    })
    assert.equal(snapshot.statusCode, 200, snapshot.body)
    const snapshotBody = snapshot.json() as { sessionId: string; sessionName: string; activeWindowId: string }
    assert.equal(snapshotBody.sessionId, baseSessionId)
    assert.equal(snapshotBody.sessionName, TEST_TMUX_SESSION)
    assert.equal(snapshotBody.activeWindowId, second.id)

    const panes = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/panes?viewId=${viewId}`,
    })
    assert.equal(panes.statusCode, 200, panes.body)

    const selected = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${baseSessionId}/windows/select`,
      payload: { windowId: first.id, viewId },
    })
    assert.equal(selected.statusCode, 200, selected.body)
    // select 不能切 base（会把另一台设备带走）：ensure 出 view 后只切 view
    const viewName = viewSessionName('local', TEST_TMUX_SESSION, viewId)
    assert.equal(await currentWindowId(TEST_TMUX_SESSION), second.id.slice('local:'.length))
    assert.equal(await currentWindowId(viewName), first.id.slice('local:'.length))
    const selectedBody = selected.json() as { windows: { id: string; sessionId: string; active: boolean }[] }
    assert.equal(
      selectedBody.windows.every((window) => window.sessionId === baseSessionId),
      true,
    )
    assert.equal(selectedBody.windows.find((window) => window.active)?.id, first.id)
  } finally {
    await killSession(viewSessionName('local', TEST_TMUX_SESSION, viewId))
    await killTestTmuxSession()
  }
})

test('viewId validation: invalid 400, collision 404', async (t) => {
  const app = await buildApp(t)
  const baseSessionId = `session-local-${TEST_TMUX_SESSION}`
  let mismatchedName = ''
  try {
    const { first } = await setupBaseWithTwoWindows()
    // 存在的 view 名但 option 指向别的 base：不能靠名字冒充
    const mismatchedId = 'mismatchview0001'
    mismatchedName = viewSessionName('local', TEST_TMUX_SESSION, mismatchedId)
    await tmux(['new-session', '-d', '-t', TEST_TMUX_SESSION, '-s', mismatchedName])
    await tmux(['set-option', '-t', mismatchedName, VIEW_BASE_OPTION, 'some-other-base'])

    const invalid = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${baseSessionId}/windows/select`,
      payload: { windowId: first.id, viewId: 'bad' },
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal((invalid.json() as { code: string }).code, 'INVALID_REQUEST')

    const invalidRead = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/windows?viewId=bad`,
    })
    assert.equal(invalidRead.statusCode, 400)
    assert.equal((invalidRead.json() as { code: string }).code, 'INVALID_REQUEST')

    const mismatched = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${baseSessionId}/windows/select`,
      payload: { windowId: first.id, viewId: 'mismatchview0001' },
    })
    assert.equal(mismatched.statusCode, 404)
    assert.equal((mismatched.json() as { code: string }).code, 'VIEW_CONFLICT')
  } finally {
    if (mismatchedName) await killSession(mismatchedName)
    await killTestTmuxSession()
  }
})

test('TMUXGO_VIEWS=0 ignores viewId and keeps the old base path', async (t) => {
  const app = await buildApp(t)
  const viewId = 'disabledview0001'
  let viewName = ''
  const previous = process.env.TMUXGO_VIEWS
  try {
    const { first, second } = await setupBaseWithTwoWindows()
    viewName = await createGroupedView(TEST_TMUX_SESSION, viewId)
    await tmux(['select-window', '-t', `${TEST_TMUX_SESSION}:${second.index}`])
    await tmux(['select-window', '-t', `${viewName}:${second.index}`])
    const baseSessionId = `session-local-${TEST_TMUX_SESSION}`

    process.env.TMUXGO_VIEWS = '0'
    const selected = await app.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${baseSessionId}/windows/select`,
      payload: { windowId: first.id, viewId },
    })
    assert.equal(selected.statusCode, 200, selected.body)
    // 旧路径只改 base；view 完全不受影响
    assert.equal(await currentWindowId(TEST_TMUX_SESSION), first.id.slice('local:'.length))
    assert.equal(await currentWindowId(viewName), second.id.slice('local:'.length))

    const windows = await app.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${baseSessionId}/windows?viewId=${viewId}`,
    })
    assert.equal(windows.statusCode, 200)
    const body = windows.json() as { id: string; sessionId: string; active: boolean }[]
    assert.equal(
      body.every((window) => window.sessionId === baseSessionId),
      true,
    )
    assert.equal(body.find((window) => window.active)?.id, first.id)
  } finally {
    if (previous === undefined) delete process.env.TMUXGO_VIEWS
    else process.env.TMUXGO_VIEWS = previous
    if (viewName) await killSession(viewName)
    await killTestTmuxSession()
  }
})
