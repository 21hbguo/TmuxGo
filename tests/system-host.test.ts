import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { systemRoutes } from '../apps/gateway/src/routes/system'

test('returns local host metrics and dependency status', async (t) => {
  const app = Fastify()
  await systemRoutes(app)
  t.after(async () => app.close())
  const response = await app.inject({ method: 'GET', url: '/hosts/local/system' })
  assert.equal(response.statusCode, 200)
  const data = response.json()
  assert.equal(data.hostId, 'local')
  assert.equal(typeof data.cpu, 'number')
  assert.equal(typeof data.mem.used, 'number')
  assert.ok(Array.isArray(data.disks))
  assert.deepEqual(Object.keys(data.dependencies).sort(), ['git', 'python', 'rg', 'sshpass', 'tmux'])
  for (const available of Object.values(data.dependencies)) assert.equal(typeof available, 'boolean')
  assert.equal(data.dependencies.tmux, true)
  assert.equal(data.dependencies.git, true)
  assert.equal(data.dependencies.python, true)
  assert.equal(data.dependencies.rg, true)
})
