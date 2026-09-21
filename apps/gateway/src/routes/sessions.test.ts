import '../test-env.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Fastify from 'fastify'
import test from 'node:test'
import { sessionRoutes } from './sessions.js'

const execFileAsync = promisify(execFile)

test('deleting a session removes the tmux session used by the monitor', async () => {
  const sessionName = `tmuxgo-session-delete-${process.pid}-${Date.now()}`
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  try {
    await execFileAsync('tmux', ['new-session', '-d', '-s', sessionName])
    const response = await fastify.inject({
      method: 'DELETE',
      url: `/hosts/local/sessions/session-local-${sessionName}`,
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { success: true, sessionId: `session-local-${sessionName}` })
    await assert.rejects(execFileAsync('tmux', ['has-session', '-t', sessionName]))
  } finally {
    await fastify.close()
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
  }
})
test('creating a session with a missing cwd fails with a clear error', async () => {
  const sessionName = `tmuxgo-session-cwd-missing-${process.pid}-${Date.now()}`
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
    await assert.rejects(execFileAsync('tmux', ['has-session', '-t', sessionName]))
  } finally {
    await fastify.close()
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
  }
})
test('creating a session with a valid cwd starts in that directory', async () => {
  const sessionName = `tmuxgo-session-cwd-ok-${process.pid}-${Date.now()}`
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
    const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', sessionName, '#{pane_current_path}'])
    assert.equal(stdout.trim(), cwd)
  } finally {
    await fastify.close()
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
  }
})
