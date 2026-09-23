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
