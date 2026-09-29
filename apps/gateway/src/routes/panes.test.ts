import '../test-env.js'
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { paneRoutes } from './panes.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
test('returns the current path for a local pane', async () => {
  const sessionName = TEST_TMUX_SESSION
  const cwd = process.cwd()
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd])
    const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    const paneId = `local:${stdout.trim().split('\n')[0]}`
    const response = await fastify.inject({ method: 'POST', url: '/panes/cwd', payload: { paneId } })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { ok: boolean; cwd?: string }
    assert.equal(body.ok, true)
    assert.equal(body.cwd, await realpath(cwd).catch(() => cwd))
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
// keepZoom 语义：zoom 状态下 select-pane -Z 直接换 zoomed pane 不退出 zoom；
// 不带 keepZoom 维持旧语义（select 会 unzoom）——移动端 zoom 全屏翻页依赖此区分
test('keeps window zoomed when selecting another pane with keepZoom', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40'])
    await execTmuxFile('tmux', ['split-window', '-t', sessionName, '-h'])
    const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    const [p0, p1] = stdout.trim().split('\n')
    await execTmuxFile('tmux', ['select-pane', '-t', p0])
    await execTmuxFile('tmux', ['resize-pane', '-Z', '-t', p0])
    const response = await fastify.inject({
      method: 'POST',
      url: '/panes/select',
      payload: { paneId: `local:${p1}`, keepZoom: true },
    })
    assert.equal(response.statusCode, 200)
    assert.equal((response.json() as { ok: boolean }).ok, true)
    const { stdout: zoomed } = await execTmuxFile('tmux', [
      'display-message',
      '-p',
      '-t',
      sessionName,
      '#{window_zoomed_flag}|#{pane_id}',
    ])
    assert.equal(zoomed.trim(), `1|${p1}`)
    const plain = await fastify.inject({ method: 'POST', url: '/panes/select', payload: { paneId: `local:${p0}` } })
    assert.equal((plain.json() as { ok: boolean }).ok, true)
    const { stdout: unzoomed } = await execTmuxFile('tmux', [
      'display-message',
      '-p',
      '-t',
      sessionName,
      '#{window_zoomed_flag}|#{pane_id}',
    ])
    assert.equal(unzoomed.trim(), `0|${p0}`)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
// selection-state 供前端拖选轮询：tmux copy-mode 内的选区坐标/标志（mouse on
// 时拖选全归 tmux，浏览器侧无选区）；send-keys -X 可在 detached session 里
// 驱动真实 copy-mode 选区
test('reports tmux copy-mode selection coordinates', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24'])
    // 先铺几行内容再进 copy-mode：空行上 cursor-right 的选区坐标行为不稳定
    for (const line of ['AAAAAAAAAAAA', 'BBBBBBBBBBBB', 'CCCCCCCCCCCC']) {
      await execTmuxFile('tmux', ['send-keys', '-t', sessionName, `echo ${line}`, 'Enter'])
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    const pane = stdout.trim().split('\n')[0]
    const paneId = `local:${pane}`
    const idle = await fastify.inject({ method: 'POST', url: '/panes/selection-state', payload: { paneId } })
    assert.equal(idle.statusCode, 200)
    assert.deepEqual((idle.json() as { ok: boolean; inCopyMode?: boolean; present?: boolean }).inCopyMode, false)
    await execTmuxFile('tmux', ['copy-mode', '-t', pane])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'top-line'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'begin-selection'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'cursor-down'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'cursor-right'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'cursor-right'])
    const response = await fastify.inject({ method: 'POST', url: '/panes/selection-state', payload: { paneId } })
    const body = response.json() as {
      ok: boolean
      inCopyMode?: boolean
      selecting?: boolean
      present?: boolean
      startX?: number
      startY?: number
      endX?: number
      endY?: number
      rectangle?: boolean
    }
    assert.equal(body.ok, true)
    assert.equal(body.inCopyMode, true)
    assert.equal(body.present, true)
    assert.equal(body.startX, 0)
    assert.equal(body.startY, 0)
    assert.equal(body.endX, 2)
    assert.equal(body.endY, 1)
    assert.equal(body.rectangle, false)
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'cancel'])
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
// copy-selection 用「最新 buffer 名 != since」等 copy-selection-and-cancel 落盘：
// 无 since 直接取最新（arm 基线/peek），since 匹配时轮询到新 buffer 或超时
test('returns the newest tmux paste buffer after a copy', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24'])
    const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    const pane = stdout.trim().split('\n')[0]
    const paneId = `local:${pane}`
    const peek = await fastify.inject({ method: 'POST', url: '/panes/copy-selection', payload: { paneId, peek: true } })
    const base = peek.json() as { ok: boolean; found?: boolean; name?: string }
    assert.equal(base.ok, true)
    await execTmuxFile('tmux', ['copy-mode', '-t', pane])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'top-line'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'begin-selection'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'cursor-right'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'cursor-right'])
    await execTmuxFile('tmux', ['send-keys', '-X', '-t', pane, 'copy-selection-and-cancel'])
    const response = await fastify.inject({
      method: 'POST',
      url: '/panes/copy-selection',
      payload: { paneId, since: base.found ? base.name : undefined },
    })
    const body = response.json() as { ok: boolean; found?: boolean; name?: string; text?: string }
    assert.equal(body.ok, true)
    assert.equal(body.found, true)
    assert.notEqual(body.name, base.name)
    assert.equal(typeof body.text, 'string')
    assert.ok((body.text ?? '').length > 0)
    const stale = await fastify.inject({
      method: 'POST',
      url: '/panes/copy-selection',
      payload: { paneId, since: body.name },
    })
    assert.equal((stale.json() as { ok: boolean; found?: boolean }).found, false)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('rejects malformed and unknown pane ids without throwing', async () => {
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    const malformed = await fastify.inject({ method: 'POST', url: '/panes/cwd', payload: { paneId: 'local-pane' } })
    assert.equal(malformed.statusCode, 200)
    assert.equal((malformed.json() as { ok: boolean }).ok, false)
    const missing = await fastify.inject({ method: 'POST', url: '/panes/cwd', payload: { paneId: 'local:%99999999' } })
    assert.equal(missing.statusCode, 200)
    assert.equal((missing.json() as { ok: boolean }).ok, false)
  } finally {
    await fastify.close()
  }
})
