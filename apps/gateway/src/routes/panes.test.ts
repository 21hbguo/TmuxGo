import '../test-env.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import Fastify from 'fastify'
import test from 'node:test'
import { paneRoutes } from './panes.js'

const execFileAsync = promisify(execFile)

test('returns the current path for a local pane', async () => {
  const sessionName = `tmuxgo-pane-cwd-${process.pid}-${Date.now()}`
  const cwd = process.cwd()
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    await execFileAsync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd])
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    const paneId = `local:${stdout.trim().split('\n')[0]}`
    const response = await fastify.inject({ method: 'POST', url: '/panes/cwd', payload: { paneId } })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { ok: boolean; cwd?: string }
    assert.equal(body.ok, true)
    assert.equal(body.cwd, await realpath(cwd).catch(() => cwd))
  } finally {
    await fastify.close()
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
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
