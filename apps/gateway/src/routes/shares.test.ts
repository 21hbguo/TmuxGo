import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import test from 'node:test'

test('creates, exchanges, and revokes scoped share links without exposing tokens', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-share-route-'))
  const auditPath = path.join(configDir, 'audit.ndjson')
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const previousAuditPath = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_CONFIG_DIR = configDir
  process.env.TMUXGO_AUDIT_LOG = auditPath
  try {
    const { agentManager } = await import('../agent-manager.js')
    const { shareRoutes } = await import(`./shares.js?test=${Date.now()}-${Math.random()}`)
    const fastify = Fastify()
    await fastify.register(shareRoutes)
    const agentSocket = { readyState: 1, send: () => {} } as any
    agentManager.register('agent-only', 'Agent only', '127.0.0.1', '1.0.0', agentSocket)
    const missingHost = await fastify.inject({
      method: 'POST',
      url: '/shares',
      payload: { hostId: 'missing', sessionName: 'dev', expiresInMinutes: 60 },
    })
    assert.equal(missingHost.statusCode, 404)
    const agentCreated = await fastify.inject({
      method: 'POST',
      url: '/shares',
      payload: { hostId: 'agent-only', sessionName: 'dev', expiresInMinutes: 60 },
    })
    assert.equal(agentCreated.statusCode, 200)
    const created = await fastify.inject({
      method: 'POST',
      url: '/shares',
      payload: { hostId: 'local', sessionName: 'dev', expiresInMinutes: 60 },
    })
    assert.equal(created.statusCode, 200)
    const link = created.json() as { id: string; token: string }
    assert.equal(typeof link.token, 'string')
    const listed = await fastify.inject({ method: 'GET', url: '/shares' })
    assert.equal(listed.statusCode, 200)
    assert.equal(JSON.stringify(listed.json()).includes(link.token), false)
    const exchanged = await fastify.inject({ method: 'POST', url: '/shares/exchange', payload: { token: link.token } })
    assert.equal(exchanged.statusCode, 200)
    const exchange = exchanged.json() as Record<string, unknown>
    assert.deepEqual(Object.keys(exchange).sort(), ['expiresAt', 'expiresIn', 'hostId', 'sessionName', 'ticket'])
    const audit = await readFile(auditPath, 'utf8')
    assert.equal(audit.includes(link.token), false)
    assert.equal(audit.includes('share.use'), true)
    const revoked = await fastify.inject({ method: 'DELETE', url: `/shares/${link.id}` })
    assert.equal(revoked.statusCode, 200)
    const unavailable = await fastify.inject({
      method: 'POST',
      url: '/shares/exchange',
      payload: { token: link.token },
    })
    assert.equal(unavailable.statusCode, 401)
    assert.equal(agentManager.unregister('agent-only', agentSocket), true)
    await fastify.close()
  } finally {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    if (previousAuditPath === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAuditPath
    await rm(configDir, { recursive: true, force: true })
  }
})
