import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { auditRoutes } from '../apps/gateway/src/routes/audit'
import { readAuditEvents, recordAuditRequest } from '../apps/gateway/src/lib/audit-log'

test('records mutation requests and filters audit events', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-audit-'))
  process.env.TMUXGO_AUDIT_LOG = path.join(dir, 'audit.ndjson')
  const app = Fastify()
  app.addHook('onSend', recordAuditRequest)
  app.post('/api/hosts/:hostId/sessions', async () => ({ ok: true }))
  await app.register(auditRoutes, { prefix: '/api' })
  t.after(async () => {
    await app.close()
    delete process.env.TMUXGO_AUDIT_LOG
    await rm(dir, { recursive: true, force: true })
  })
  const response = await app.inject({ method: 'POST', url: '/api/hosts/local/sessions', payload: { name: 'dev', password: 'hidden' } })
  assert.equal(response.statusCode, 200)
  const events = await readAuditEvents({ action: 'sessions', result: 'success' })
  assert.equal(events.length, 1)
  assert.equal(events[0].hostId, 'local')
  assert.equal(events[0].target.includes('hidden'), false)
  const list = await app.inject({ method: 'GET', url: '/api/audit-log?result=success' })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().events.length, 1)
})
