import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { syncPaneRoutes } from './sync-panes.js'
import { clearSyncMembers } from '../lib/sync-panes.js'
import type { RequestPrincipal } from '../lib/principal.js'

async function createFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const fastify = Fastify()
  await fastify.register(syncPaneRoutes)
  t.after(async () => {
    await fastify.close()
    await clearSyncMembers()
  })
  return fastify
}

test('stores the broadcast group and returns it back', async (t) => {
  const fastify = await createFixture(t)
  const panes = [
    { paneId: 'local:%1', sessionName: 'dev' },
    { paneId: 'remote:%2', sessionName: 'dev' },
  ]
  const put = await fastify.inject({ method: 'PUT', url: '/sync-panes', payload: { panes } })
  assert.equal(put.statusCode, 200)
  assert.deepEqual((put.json() as { panes: unknown }).panes, panes)
  const get = await fastify.inject({ method: 'GET', url: '/sync-panes' })
  assert.deepEqual((get.json() as { panes: unknown }).panes, panes)
  const cleared = await fastify.inject({ method: 'DELETE', url: '/sync-panes' })
  assert.deepEqual((cleared.json() as { panes: unknown[] }).panes, [])
  assert.deepEqual((await fastify.inject({ method: 'GET', url: '/sync-panes' })).json() as { panes: unknown[] }, {
    panes: [],
    max: 16,
  })
})

test('rejects malformed pane references and oversized groups', async (t) => {
  const fastify = await createFixture(t)
  const malformed = await fastify.inject({
    method: 'PUT',
    url: '/sync-panes',
    payload: { panes: [{ paneId: 'not-a-pane', sessionName: 'dev' }] },
  })
  assert.equal(malformed.statusCode, 400)
  const tooMany = await fastify.inject({
    method: 'PUT',
    url: '/sync-panes',
    payload: {
      panes: Array.from({ length: 17 }, (_, index) => ({ paneId: `local:%${index + 1}`, sessionName: 'dev' })),
    },
  })
  assert.equal(tooMany.statusCode, 400)
  const notArray = await fastify.inject({ method: 'PUT', url: '/sync-panes', payload: { panes: 'local:%1' } })
  assert.equal(notArray.statusCode, 400)
})

test('refuses to add panes outside the caller scope', async (t) => {
  const fastify = await createFixture(t)
  // 受限身份：只能碰 local 的 dev session。广播是写能力，越权 pane 一律不进组，
  // 否则后续 input 帧会写到 allowlist 之外
  fastify.addHook('preHandler', async (request) => {
    const principal = {
      actor: 'restricted',
      source: 'http',
      scope: { hosts: ['local'], sessions: ['dev'] },
    } as RequestPrincipal
    request.principal = principal
  })
  const deniedHost = await fastify.inject({
    method: 'PUT',
    url: '/sync-panes',
    payload: { panes: [{ paneId: 'other:%1', sessionName: 'dev' }] },
  })
  assert.equal(deniedHost.statusCode, 403)
  const deniedSession = await fastify.inject({
    method: 'PUT',
    url: '/sync-panes',
    payload: { panes: [{ paneId: 'local:%1', sessionName: 'secret' }] },
  })
  assert.equal(deniedSession.statusCode, 403)
  const allowed = await fastify.inject({
    method: 'PUT',
    url: '/sync-panes',
    payload: { panes: [{ paneId: 'local:%1', sessionName: 'dev' }] },
  })
  assert.equal(allowed.statusCode, 200)
})
