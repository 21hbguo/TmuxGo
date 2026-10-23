import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../apps/gateway/src/test-tmux'
import { windowRoutes } from '../apps/gateway/src/routes/windows'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
const sessionName = TEST_TMUX_SESSION
const sessionId = `session-local-${sessionName}`

type WindowRow = { id: string; tmuxWindowId: string; index: number; name: string; active: boolean }
type PaneRow = { id: string; tmuxPaneId: string; windowId: string; index: number; name?: string; windowName?: string }

async function tmux(args: string[]) {
  return (await execTmuxFile('tmux', args)).stdout
}

// 每个用例起一套干净环境：session test + 三个窗口（main/alpha/beta），索引按 server 自身 base-index 走
async function resetWindows(t: test.TestContext) {
  const fastify = Fastify()
  await windowRoutes(fastify)
  await killTestTmuxSession()
  await tmux(['new-session', '-d', '-s', sessionName, '-n', 'main'])
  await tmux(['new-window', '-d', '-t', `${sessionName}:`, '-n', 'alpha'])
  await tmux(['new-window', '-d', '-t', `${sessionName}:`, '-n', 'beta'])
  t.after(async () => {
    await fastify.close()
    await killTestTmuxSession()
  })
  return fastify
}

async function listWindows(fastify: Fastify) {
  const response = await fastify.inject({ method: 'GET', url: `/hosts/local/sessions/${sessionId}/windows` })
  assert.equal(response.statusCode, 200)
  return response.json() as WindowRow[]
}

function windowByName(windows: WindowRow[], name: string) {
  const hit = windows.find((window) => window.name === name)
  assert.ok(hit, `window ${name} missing from ${JSON.stringify(windows.map((w) => w.name))}`)
  return hit
}

test('window routes return the created window and active pane from the active window', async () => {
  const fastify = Fastify()
  await windowRoutes(fastify)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName])
    const { stdout } = await execTmuxFile('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
    const firstIndex = Number(stdout.trim())
    await execTmuxFile('tmux', ['new-window', '-d', '-t', `${sessionName}:${firstIndex + 2}`, '-n', 'old-last'])
    const createResponse = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${sessionId}/windows`,
      payload: { name: 'created' },
    })
    assert.equal(createResponse.statusCode, 200)
    const created = createResponse.json()
    assert.equal(created.name, 'created')
    assert.equal(created.index, firstIndex + 1)
    assert.equal(created.active, true)
    const snapshotResponse = await fastify.inject({ method: 'GET', url: `/hosts/local/sessions/${sessionId}/snapshot` })
    assert.equal(snapshotResponse.statusCode, 200)
    const snapshot = snapshotResponse.json() as {
      panes: Array<{ id: string; windowId: string }>
      activePaneId: string
      activeWindowId: string
    }
    const activePane = snapshot.panes.find((pane) => pane.id === snapshot.activePaneId)
    assert.ok(activePane)
    assert.equal(activePane.windowId, snapshot.activeWindowId)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('select switches the active window by id and rejects targets outside the session', async (t) => {
  const fastify = await resetWindows(t)
  const windows = await listWindows(fastify)
  const beta = windowByName(windows, 'beta')
  assert.equal(beta.active, false)

  const response = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/select`,
    payload: { windowId: beta.id },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.ok, true)
  assert.equal(
    (body.windows as WindowRow[])
      .filter((window) => window.active)
      .map((window) => window.id)
      .join(','),
    beta.id,
  )
  // 对照 tmux 真实状态：active 判定来自 select-window，不是返回体自证
  assert.equal((await tmux(['display-message', '-p', '-t', sessionName, '#{window_id}'])).trim(), beta.tmuxWindowId)

  // 不属于本 host 的 window id：跨 host 引用属调用方错误 → 400（契约归位后不再是 500）
  const foreign = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/select`,
    payload: { windowId: `other-host:${beta.tmuxWindowId}` },
  })
  assert.equal(foreign.statusCode, 400)
  assert.deepEqual(foreign.json(), { message: 'Window does not belong to host', code: 'INVALID_REQUEST' })

  // 不存在的 window：tmux 解析不到目标 → 404，原文留在 message 里
  const missing = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/select`,
    payload: { windowId: 'local:@9999' },
  })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().code, 'WINDOW_NOT_FOUND')
  assert.ok(missing.json().message)
})

test('select works for a window at a non-contiguous index (base-index independent)', async (t) => {
  const fastify = await resetWindows(t)
  await tmux(['new-window', '-d', '-t', `${sessionName}:7`, '-n', 'far-index'])
  const far = windowByName(await listWindows(fastify), 'far-index')
  assert.equal(far.index, 7)

  const response = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/select`,
    payload: { windowId: far.id },
  })
  assert.equal(response.json().ok, true)
  assert.equal((await tmux(['display-message', '-p', '-t', sessionName, '#{window_id}'])).trim(), far.tmuxWindowId)
})

test('rename applies the new name and reports invalid targets without throwing', async (t) => {
  const fastify = await resetWindows(t)
  const beta = windowByName(await listWindows(fastify), 'beta')

  const renamed = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/rename`,
    payload: { windowId: beta.id, name: 'renamed-beta' },
  })
  assert.equal(renamed.json().ok, true)
  assert.ok((renamed.json().windows as WindowRow[]).some((window) => window.name === 'renamed-beta'))
  assert.match(await tmux(['list-windows', '-t', sessionName, '-F', '#{window_name}']), /^renamed-beta$/m)

  // 同名重命名：tmux 允许多窗口同名，路由不得自行去重或拒绝
  const duplicate = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/rename`,
    payload: { windowId: windowByName(await listWindows(fastify), 'alpha').id, name: 'renamed-beta' },
  })
  assert.equal(duplicate.json().ok, true)
  assert.equal(
    (await tmux(['list-windows', '-t', sessionName, '-F', '#{window_name}']))
      .trim()
      .split('\n')
      .filter((name) => name === 'renamed-beta').length,
    2,
  )

  // 非法 id 形态：解析失败 → 400（契约归位后不再是 500）
  const malformed = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/rename`,
    payload: { windowId: 'local:not-a-window', name: 'x' },
  })
  assert.equal(malformed.statusCode, 400)
  assert.deepEqual(malformed.json(), { message: 'Invalid window id', code: 'INVALID_REQUEST' })

  // 不存在但形态合法的 window：目标缺失 → 404
  const missing = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/rename`,
    payload: { windowId: 'local:@9999', name: 'x' },
  })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().code, 'WINDOW_NOT_FOUND')
})

test('move renumbers windows into the requested order', async (t) => {
  const fastify = await resetWindows(t)
  const windows = await listWindows(fastify)
  const requested = [windowByName(windows, 'beta'), windowByName(windows, 'main'), windowByName(windows, 'alpha')]

  const response = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/move`,
    payload: { orderedWindowIds: requested.map((window) => window.id) },
  })
  assert.equal(response.json().ok, true)
  const moved = response.json().windows as WindowRow[]
  assert.deepEqual(
    moved.map((window) => window.name),
    ['beta', 'main', 'alpha'],
  )
  // 规范化后索引必定从 0 连续排布，与 server 的 base-index 无关
  assert.deepEqual(
    moved.map((window) => window.index),
    [0, 1, 2],
  )
  assert.equal(
    (await tmux(['list-windows', '-t', sessionName, '-F', '#{window_name}'])).trim().split('\n').join(','),
    'beta,main,alpha',
  )

  // 跨 host 的 id 混入：整体拒绝，不做部分重排（调用方错误 → 400）
  const foreign = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/move`,
    payload: { orderedWindowIds: [`other-host:${requested[0].tmuxWindowId}`] },
  })
  assert.equal(foreign.statusCode, 400)
  assert.deepEqual(foreign.json(), { message: 'Window does not belong to host', code: 'INVALID_REQUEST' })

  const empty = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/move`,
    payload: {},
  })
  assert.equal(empty.statusCode, 400)
  assert.deepEqual(empty.json(), { message: 'orderedWindowIds is required', code: 'INVALID_REQUEST' })
})

test('kill removes one window and reports the last-window session teardown as a failure', async (t) => {
  const fastify = await resetWindows(t)
  const windows = await listWindows(fastify)
  const alpha = windowByName(windows, 'alpha')

  const killed = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/kill`,
    payload: { windowId: alpha.id },
  })
  assert.equal(killed.json().ok, true)
  assert.ok(!(killed.json().windows as WindowRow[]).some((window) => window.name === 'alpha'))
  await assert.rejects(tmux(['list-windows', '-t', `${sessionName}:${alpha.tmuxWindowId}`, '-F', '#{window_id}']))

  // 最后一个 window 被 kill 时 tmux 会销毁整个 session：路由必须回报失败而不是假装成功
  const remaining = await listWindows(fastify)
  for (const window of remaining.slice(0, -1)) {
    const response = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${sessionId}/windows/kill`,
      payload: { windowId: window.id },
    })
    assert.equal(response.json().ok, true)
  }
  const last = (await listWindows(fastify))[0]
  const lastResponse = await fastify.inject({
    method: 'POST',
    url: `/hosts/local/sessions/${sessionId}/windows/kill`,
    payload: { windowId: last.id },
  })
  // kill 本身成功，但随后的 list-windows 撞上「session 已被销毁」→ 契约归位为 404（含 tmux 原文）
  assert.equal(lastResponse.statusCode, 404)
  // tmux 可能报 can't find window 或 can't find session（kill 成功后 store 里已无该 session），
  // 只要 404 + *_NOT_FOUND 形态成立即可，具体资源名随 tmux 文案
  assert.match(String(lastResponse.json().code), /_NOT_FOUND$/)
  assert.match(String(lastResponse.json().message), /can't find session|no server running|no current target/i)
  await assert.rejects(tmux(['has-session', '-t', sessionName]))
})

test('lists panes per window and per session with their window metadata', async (t) => {
  const fastify = await resetWindows(t)
  const beta = windowByName(await listWindows(fastify), 'beta')

  const windowPanes = await fastify.inject({ method: 'GET', url: `/windows/${beta.id}/panes` })
  assert.equal(windowPanes.statusCode, 200)
  const panes = windowPanes.json() as PaneRow[]
  assert.equal(panes.length, 1)
  assert.equal(panes[0].windowId, beta.id)
  assert.ok(Number.isInteger(panes[0].index))

  const sessionPanes = await fastify.inject({ method: 'GET', url: `/hosts/local/sessions/${sessionId}/panes` })
  const allPanes = sessionPanes.json() as PaneRow[]
  assert.equal(allPanes.length, 3)
  assert.deepEqual(allPanes.map((pane) => pane.windowName).sort(), ['alpha', 'beta', 'main'])
  assert.equal(new Set(allPanes.map((pane) => pane.windowId)).size, 3)

  // 非法 window 形态：解析阶段拒绝 → 400
  const malformed = await fastify.inject({ method: 'GET', url: '/windows/local:not-a-window/panes' })
  assert.equal(malformed.statusCode, 400)
  assert.deepEqual(malformed.json(), { message: 'Invalid window id', code: 'INVALID_REQUEST' })
})

test('returns pane output and rejects pane ids from another host', async (t) => {
  const fastify = await resetWindows(t)
  const beta = windowByName(await listWindows(fastify), 'beta')
  const pane = ((await fastify.inject({ method: 'GET', url: `/windows/${beta.id}/panes` })).json() as PaneRow[])[0]

  await tmux(['send-keys', '-t', pane.tmuxPaneId, 'printf "MARKER-42 中文\\n"', 'Enter'])
  const deadline = Date.now() + 5000
  let output = ''
  while (Date.now() < deadline && !output.includes('MARKER-42')) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const response = await fastify.inject({ method: 'GET', url: `/panes/${encodeURIComponent(pane.id)}/output` })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().paneId, pane.id)
    assert.equal(response.json().tmuxPaneId, pane.tmuxPaneId)
    output = response.json().data
  }
  assert.match(output, /MARKER-42 中文/)

  // hostId 由 paneId 前缀派生，跨 host 的 pane 会先撞上 host 查找；断言拒绝而不挂起
  const foreign = await fastify.inject({ method: 'GET', url: `/panes/${encodeURIComponent('other-host:%1')}/output` })
  assert.equal(foreign.statusCode, 404)
  assert.equal(foreign.json().code, 'HOST_NOT_FOUND')
  assert.match(String(foreign.json().message), /Host "other-host" not found/)

  // id 形态非法（缺 % 前缀）在解析阶段拒绝 → 400
  const malformed = await fastify.inject({ method: 'GET', url: '/panes/local:not-a-pane/output' })
  assert.equal(malformed.statusCode, 400)
  assert.deepEqual(malformed.json(), { message: 'Invalid pane id', code: 'INVALID_REQUEST' })
})

test('reports a missing session as a JSON error instead of hanging', async (t) => {
  const fastify = await resetWindows(t)
  // 契约归位后缺 session → 404 SESSION_NOT_FOUND，message 仍是 tmux 原文
  const response = await fastify.inject({
    method: 'GET',
    url: '/hosts/local/sessions/session-local-absent/windows',
  })
  assert.equal(response.statusCode, 404)
  assert.equal(response.json().code, 'SESSION_NOT_FOUND')
  assert.match(String(response.json().message), /can't find (session|window)|no server running|error connecting/)
  const created = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/sessions/session-local-absent/windows',
    payload: { name: 'nope' },
  })
  assert.equal(created.statusCode, 404)
  // tmux 侧文案随 server 状态变化（can't find session / no current target），只钉 404 与 code 形态
  assert.match(String(created.json().code), /_NOT_FOUND$/)
  assert.match(String(created.json().message), /can't find (session|window)|no server running|error connecting/)
})
