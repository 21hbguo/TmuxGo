import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import type { AccessScope } from '../lib/access-scope.js'
import { countLayoutPanes } from '../lib/layout-string.js'
import { sessionRoutes } from './sessions.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（见 test-tmux.ts 约定），
// 同文件用例串行执行，每个用例自己重建 test session。
const layoutUrl = `/hosts/local/sessions/session-local-${TEST_TMUX_SESSION}/layout-string`

async function tmux(...args: string[]) {
  const { stdout } = await execTmuxFile('tmux', args)
  return stdout.trim()
}

// 起 test session（首窗口 1 pane）
async function startSession() {
  await killTestTmuxSession()
  await tmux('new-session', '-d', '-s', TEST_TMUX_SESSION)
}

// 新建一个窗口并按需切分；返回窗口 id（@N）
async function createWindow(name: string, splits: string[] = []) {
  const windowId = await tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${TEST_TMUX_SESSION}:`, '-n', name)
  for (const direction of splits) await tmux('split-window', direction, '-t', windowId)
  return windowId
}

// pane 几何指纹：排序后逐行比较，与 pane 序号无关
async function windowGeometry(windowId: string) {
  const stdout = await tmux('list-panes', '-t', windowId, '-F', '#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}')
  return stdout.split('\n').filter(Boolean).sort()
}

async function makeApp(scope?: AccessScope) {
  const fastify = Fastify()
  if (scope) {
    // 全局 accessScopeGuard 之外，layout-string 路由内还会按 session 再判一次；
    // 这里直接注入受限身份来验证那一层（与 pane-search.test.ts 同一手法）
    fastify.addHook('onRequest', async (request) => {
      request.principal = { actor: 'token:test', source: 'http', scope }
    })
  }
  await fastify.register(sessionRoutes)
  return fastify
}

test('GET returns a layout string that parses back to the window pane count', async () => {
  const fastify = await makeApp()
  try {
    await startSession()
    const windowId = await createWindow('two', ['-h'])
    const response = await fastify.inject({ method: 'GET', url: `${layoutUrl}?windowId=${windowId}` })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.windowId, windowId)
    assert.equal(body.panes, 2)
    assert.match(body.layout, /^[0-9a-f]{4},\d+x\d+,\d+,\d+/)
    assert.equal(countLayoutPanes(body.layout), 2)
    // 尺寸取的是窗口实际尺寸，不是从 layout 串里猜的
    const size = await tmux('display-message', '-p', '-t', windowId, '#{window_width}|#{window_height}')
    const [cols, rows] = size.split('|').map((value) => Number(value))
    assert.deepEqual({ cols: body.cols, rows: body.rows }, { cols, rows })
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('GET without windowId reads the session active window', async () => {
  const fastify = await makeApp()
  try {
    await startSession()
    const windowId = await createWindow('active', ['-h'])
    await tmux('select-window', '-t', windowId)
    const response = await fastify.inject({ method: 'GET', url: layoutUrl })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().windowId, windowId)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('POST apply copies pane geometry from another window', async () => {
  const fastify = await makeApp()
  try {
    await startSession()
    // 源窗口横向两栏，目标窗口纵向两行：套用后几何必须与源窗口一致
    const source = await createWindow('source', ['-h'])
    const target = await createWindow('target', ['-v'])
    assert.notDeepEqual(await windowGeometry(target), await windowGeometry(source))
    const layout = (await fastify.inject({ method: 'GET', url: `${layoutUrl}?windowId=${source}` })).json().layout
    const response = await fastify.inject({
      method: 'POST',
      url: `${layoutUrl}/apply`,
      payload: { windowId: target, layout },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, windowId: target, panes: 2 })
    assert.deepEqual(await windowGeometry(target), await windowGeometry(source))
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('POST apply rejects a layout whose pane count differs and keeps geometry intact', async () => {
  const fastify = await makeApp()
  try {
    await startSession()
    const source = await createWindow('source', ['-h'])
    const threePanes = await createWindow('three', ['-h', '-v'])
    assert.equal((await windowGeometry(threePanes)).length, 3)
    const before = await windowGeometry(threePanes)
    const layout = (await fastify.inject({ method: 'GET', url: `${layoutUrl}?windowId=${source}` })).json().layout
    const response = await fastify.inject({
      method: 'POST',
      url: `${layoutUrl}/apply`,
      payload: { windowId: threePanes, layout },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, 'LAYOUT_PANE_MISMATCH')
    assert.match(body.message, /have 3 panes but need 2/)
    assert.deepEqual(await windowGeometry(threePanes), before)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('POST apply rejects malformed layout strings with LAYOUT_INVALID', async () => {
  const fastify = await makeApp()
  try {
    await startSession()
    const windowId = await createWindow('two', ['-h'])
    for (const layout of [
      '',
      'zzzz,80x24,0,0{40x24,0,0,0,40x24,40,0,1}',
      '8f4f,80x24,0,0{40x24,0,0,0,40x24,40,0,1', // 截断：少收尾大括号
      '8f4f,80x24,0,0{40x24,0,0,0,40x24,40,0,1}', // 结构合法但校验和是编的
      '8f4f,80x24,0,0; rm -rf /',
    ]) {
      const response = await fastify.inject({
        method: 'POST',
        url: `${layoutUrl}/apply`,
        payload: { windowId, layout },
      })
      assert.equal(response.statusCode, 400, `${layout} => ${response.body}`)
      assert.equal(response.json().code, 'LAYOUT_INVALID', layout)
    }
    // windowId 形态不对时同样是调用方错误
    const badWindow = await fastify.inject({
      method: 'POST',
      url: `${layoutUrl}/apply`,
      payload: { windowId: windowId.replace('@', ''), layout: '8f4f,80x24,0,0{40x24,0,0,0,40x24,40,0,1}' },
    })
    assert.equal(badWindow.statusCode, 400)
    assert.equal(badWindow.json().code, 'INVALID_WINDOW_ID')
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('GET rejects windows outside the session and unknown sessions', async () => {
  const fastify = await makeApp()
  try {
    await startSession()
    // @999 不属于 test session（隔离 server 上只有 test，不会误判成真实窗口）
    const missingWindow = await fastify.inject({ method: 'GET', url: `${layoutUrl}?windowId=@999` })
    assert.equal(missingWindow.statusCode, 404)
    assert.equal(missingWindow.json().code, 'WINDOW_NOT_FOUND')
    await killTestTmuxSession()
    const missingSession = await fastify.inject({ method: 'GET', url: layoutUrl })
    assert.equal(missingSession.statusCode, 404)
    assert.equal(missingSession.json().code, 'SESSION_NOT_FOUND')
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('restricted principals cannot read or apply layouts outside their scope', async () => {
  const denied = await makeApp({ hosts: ['local'], sessions: ['other'] })
  const allowed = await makeApp({ hosts: ['local'], sessions: [TEST_TMUX_SESSION] })
  try {
    await startSession()
    const windowId = await createWindow('two', ['-h'])
    const layout = await tmux('display-message', '-p', '-t', windowId, '#{window_layout}')
    // scope 外：读布局与套布局都必须 403，且不能真的动到目标窗口
    const deniedGet = await denied.inject({ method: 'GET', url: `${layoutUrl}?windowId=${windowId}` })
    assert.equal(deniedGet.statusCode, 403)
    assert.deepEqual(deniedGet.json(), { ok: false, code: 'SESSION_NOT_ALLOWED', message: 'Session is not allowed' })
    const before = await windowGeometry(windowId)
    const deniedApply = await denied.inject({
      method: 'POST',
      url: `${layoutUrl}/apply`,
      payload: { windowId, layout },
    })
    assert.equal(deniedApply.statusCode, 403)
    assert.deepEqual(deniedApply.json(), { ok: false, code: 'SESSION_NOT_ALLOWED', message: 'Session is not allowed' })
    assert.deepEqual(await windowGeometry(windowId), before)
    // scope 内的 session 行为不变
    const allowedGet = await allowed.inject({ method: 'GET', url: `${layoutUrl}?windowId=${windowId}` })
    assert.equal(allowedGet.statusCode, 200)
    const allowedApply = await allowed.inject({
      method: 'POST',
      url: `${layoutUrl}/apply`,
      payload: { windowId, layout },
    })
    assert.equal(allowedApply.statusCode, 200)
    assert.deepEqual(allowedApply.json(), { ok: true, windowId, panes: 2 })
  } finally {
    await denied.close()
    await allowed.close()
    await killTestTmuxSession()
  }
})
