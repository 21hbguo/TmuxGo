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
    const response = await fastify.inject({ method: 'DELETE', url: `/hosts/local/sessions/session-local-${sessionName}` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { success: true, sessionId: `session-local-${sessionName}` })
    await assert.rejects(execFileAsync('tmux', ['has-session', '-t', sessionName]))
  } finally {
    await fastify.close()
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
  }
})
