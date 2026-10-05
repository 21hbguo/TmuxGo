import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { sessionRoutes } from './sessions.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定），
// 同文件用例串行执行，各自建/删 test
test('deleting a session removes the tmux session used by the monitor', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName])
    const response = await fastify.inject({
      method: 'DELETE',
      url: `/hosts/local/sessions/session-local-${sessionName}`,
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { success: true, sessionId: `session-local-${sessionName}` })
    await assert.rejects(execTmuxFile('tmux', ['has-session', '-t', sessionName]))
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('creating a session with a missing cwd fails with a clear error', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    const response = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/sessions',
      payload: { name: sessionName, cwd: `/tmp/tmuxgo-missing-cwd-${process.pid}-${Date.now()}` },
    })
    assert.equal(response.statusCode, 500)
    assert.match(String(response.json().message || ''), /cwd directory does not exist/)
    await assert.rejects(execTmuxFile('tmux', ['has-session', '-t', sessionName]))
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('creating a session with a valid cwd starts in that directory', async () => {
  const sessionName = TEST_TMUX_SESSION
  const cwd = process.cwd()
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    const response = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/sessions',
      payload: { name: sessionName, cwd },
    })
    assert.equal(response.statusCode, 200)
    const { stdout } = await execTmuxFile('tmux', ['display-message', '-p', '-t', sessionName, '#{pane_current_path}'])
    assert.equal(stdout.trim(), cwd)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('creating a session with cwd + layout delivers startup commands to panes', async () => {
  // 回归：无 client server 上非字面 send-keys 报 "no current client"（选工作区
  // 建会话必现），修复后为 send-keys -l 字面 + 独立 Enter
  const sessionName = TEST_TMUX_SESSION
  const cwd = process.cwd()
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    const response = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/sessions',
      payload: {
        name: sessionName,
        cwd,
        layout: { windows: [{ name: 'main', panes: [{ command: 'cd /tmp' }] }] },
      },
    })
    assert.equal(response.statusCode, 200, response.body)
    // startup 串为 `cd -- '<cwd>'; cd /tmp`，整串执行完 pane 才落到 /tmp——
    // 同时证明 -l 字面输入与独立 Enter 都送达
    let paneCwd = ''
    for (let attempt = 0; attempt < 50 && paneCwd !== '/tmp'; attempt += 1) {
      const { stdout } = await execTmuxFile('tmux', [
        'display-message',
        '-p',
        '-t',
        sessionName,
        '#{pane_current_path}',
      ])
      paneCwd = stdout.trim()
      if (paneCwd !== '/tmp') await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(paneCwd, '/tmp')
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('exports a session layout and re-imports it as a new session', async () => {
  const sessionName = TEST_TMUX_SESSION
  const importedName = `${sessionName}-imported`
  const cwd = process.cwd()
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd])
    const { stdout: firstIndex } = await execTmuxFile('tmux', [
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{window_index}',
    ])
    const firstWindow = `${sessionName}:${firstIndex.trim().split('\n')[0]}`
    await execTmuxFile('tmux', ['rename-window', '-t', firstWindow, 'editor'])
    await execTmuxFile('tmux', ['split-window', '-h', '-t', firstWindow, '-c', cwd])
    await execTmuxFile('tmux', ['new-window', '-t', sessionName, '-n', 'logs', '-c', cwd])
    const exported = await fastify.inject({
      method: 'GET',
      url: `/hosts/local/sessions/session-local-${sessionName}/layout`,
    })
    assert.equal(exported.statusCode, 200)
    const doc = exported.json()
    assert.equal(doc.kind, 'tmuxgo.session-layout')
    assert.equal(doc.version, 1)
    assert.equal(doc.name, sessionName)
    assert.equal(doc.windows.length, 2)
    assert.equal(doc.windows[0].panes.length, 2)
    assert.equal(JSON.stringify(doc).includes('TOKEN'), false)
    const created = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/session-layouts/apply',
      payload: { layout: doc, name: importedName },
    })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().mode, 'create')
    const { stdout: windowNames } = await execTmuxFile('tmux', [
      'list-windows',
      '-t',
      importedName,
      '-F',
      '#{window_name}',
    ])
    assert.deepEqual(windowNames.trim().split('\n').sort(), doc.windows.map((w: any) => w.name).sort())
    const { stdout: paneCount } = await execTmuxFile('tmux', [
      'list-panes',
      '-s',
      '-t',
      importedName,
      '-F',
      '#{pane_id}',
    ])
    assert.equal(paneCount.trim().split('\n').filter(Boolean).length, 3)
  } finally {
    await execTmuxFile('tmux', ['kill-session', '-t', importedName]).catch(() => {})
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('append mode adds windows without touching existing ones and requires the session to exist', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName])
    const layout = {
      kind: 'tmuxgo.session-layout',
      version: 1,
      name: 'extra',
      windows: [
        { name: 'w1', panes: [{ cwd: process.cwd() }, { cwd: process.cwd() }], splitDirection: 'horizontal' },
        { name: 'w2', panes: [{}] },
      ],
    }
    const missing = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/session-layouts/apply',
      payload: { layout, mode: 'append', name: 'no-such-session' },
    })
    assert.equal(missing.statusCode, 500)
    assert.match(String(missing.json().message || ''), /Session not found/)
    const appended = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/session-layouts/apply',
      payload: { layout, mode: 'append', name: sessionName },
    })
    assert.equal(appended.statusCode, 200)
    assert.equal(appended.json().appendedWindows, 2)
    const { stdout: windowNames } = await execTmuxFile('tmux', [
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{window_name}',
    ])
    const names = windowNames.trim().split('\n')
    assert.deepEqual(names.slice(-2).sort(), ['w1', 'w2'])
    assert.equal(names.length, 3)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('create mode refuses to overwrite an existing session without replace=true', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName])
    const layout = { windows: [{ name: 'replacement', panes: [{}] }] }
    const conflict = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/session-layouts/apply',
      payload: { layout, name: sessionName },
    })
    assert.equal(conflict.statusCode, 500)
    assert.match(String(conflict.json().message || ''), /already exists/)
    const { stdout: stillOne } = await execTmuxFile('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_name}'])
    assert.equal(stillOne.trim().split('\n').length, 1)
    const replaced = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/session-layouts/apply',
      payload: { layout, name: sessionName, replace: true },
    })
    assert.equal(replaced.statusCode, 200)
    assert.equal(replaced.json().session.replaced, true)
    const { stdout: names } = await execTmuxFile('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_name}'])
    assert.deepEqual(names.trim().split('\n'), ['replacement'])
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('import rejects invalid layout documents and unsafe cwd', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    const badVersion = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/session-layouts/apply',
      payload: { layout: { version: 9, windows: [{ name: 'w', panes: [{}] }] }, name: sessionName },
    })
    assert.equal(badVersion.statusCode, 500)
    assert.match(String(badVersion.json().message || ''), /unsupported version/)
    const badCwd = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/session-layouts/apply',
      payload: {
        layout: { windows: [{ name: 'w', panes: [{ cwd: `/tmp/tmuxgo-missing-${process.pid}-${Date.now()}` }] }] },
        name: sessionName,
      },
    })
    assert.equal(badCwd.statusCode, 500)
    assert.match(String(badCwd.json().message || ''), /cwd directory does not exist/)
    await assert.rejects(execTmuxFile('tmux', ['has-session', '-t', sessionName]))
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
