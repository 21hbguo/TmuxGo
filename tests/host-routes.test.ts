import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { agentManager } from '../apps/gateway/src/agent-manager.ts'
import { upsertRemoteHost } from '../apps/gateway/src/lib/hosts.ts'
import { hostRoutes } from '../apps/gateway/src/routes/hosts.ts'

test('configured SSH host keeps SSH status when an Agent with the same id is online', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-routes-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  const socket = {} as any
  agentManager.register('remote', 'remote-agent', '10.0.0.2', '1.0.0', socket)
  const app = Fastify()
  await app.register(hostRoutes, { prefix: '/api' })
  await upsertRemoteHost({ id: 'remote', name: 'remote-ssh', address: '10.0.0.2', user: 'guo' })
  t.after(async () => {
    agentManager.unregister('remote', socket)
    await app.close()
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
  })
  const response = await app.inject({ method: 'GET', url: '/api/hosts/remote' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().connectionMode, 'ssh')
  assert.equal(response.json().status, 'unknown')
  assert.deepEqual(response.json().tags, ['ssh'])
  assert.equal(response.json().agent.online, true)
})
