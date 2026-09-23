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
