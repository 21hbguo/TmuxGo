import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test, { type TestContext } from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
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
