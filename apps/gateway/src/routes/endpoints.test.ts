import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { endpointsRoutes } from './endpoints.js'
import { __testables, type EndpointsResult } from '../lib/endpoints.js'

const sample: EndpointsResult = {
  hostId: 'local',
  collectedAt: '2026-10-05T00:00:00.000Z',
  supported: true,
  sources: { nginx: 'ok', tailscale: 'unavailable', docker: 'ok', socket: 'ok' },
  endpoints: [
    {
      id: 'nginx-0',
      source: 'nginx',
      listen: '80',
      name: 'example.com',
      target: 'http://127.0.0.1:3001',
      detail: '/etc/nginx/sites-enabled/site',
      locations: [{ path: '/', target: 'http://127.0.0.1:3001', kind: 'proxy' }],
    },
  ],
}

test('GET /endpoints returns local collection', async () => {
  const app = Fastify()
  await app.register(endpointsRoutes, {
    collect: async (hostId: string) => {
      assert.equal(hostId, 'local')
      return sample
    },
  })
  const res = await app.inject({ method: 'GET', url: '/endpoints' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), sample)
  await app.close()
})

test('GET /hosts/:hostId/endpoints passes through hostId', async () => {
  const app = Fastify()
  await app.register(endpointsRoutes, {
    collect: async (hostId: string) => ({ ...sample, hostId }),
  })
  const res = await app.inject({ method: 'GET', url: '/hosts/nas/endpoints' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().hostId, 'nas')
  await app.close()
})

test('normalizeEndpoint filters unknown sources and caps fields', () => {
  const { normalizeEndpoint, normalizeSourceState } = __testables
  assert.equal(normalizeEndpoint({ source: 'bogus', listen: '80' }, 'x'), null)
  assert.equal(normalizeEndpoint(null, 'x'), null)
  const item = normalizeEndpoint(
    { source: 'docker', listen: '0.0.0.0:8080', name: 'c', target: ':80/tcp', detail: 'img', locations: 'nope' },
    'fb',
  )
  assert.equal(item?.id, 'fb')
  assert.equal(item?.locations, undefined)
  assert.equal(normalizeSourceState('ok'), 'ok')
  assert.equal(normalizeSourceState('error'), 'error')
  assert.equal(normalizeSourceState('whatever'), 'unavailable')
})
