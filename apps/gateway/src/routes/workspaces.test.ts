import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import test from 'node:test'
import { workspaceCreateBodySchema } from '../lib/request-validation.js'

test('workspaces CRUD roundtrip', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-workspaces-route-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  const { workspaceRoutes } = await import(`./workspaces.js?test=${Date.now()}-${Math.random()}`)
  const fastify = Fastify()
  await fastify.register(workspaceRoutes)
  const created = await fastify.inject({ method: 'POST', url: '/workspaces', payload: { name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', templateId: 'dev' } })
  assert.equal(created.statusCode, 200)
  const workspace = created.json().workspace as { id: string; name: string; path: string; templateId: string | null }
  assert.equal(workspace.name, 'tmuxgo')
  assert.equal(workspace.path, '/workspace/tmuxgo')
  assert.equal(workspace.templateId, 'dev')
  const listed = await fastify.inject({ method: 'GET', url: '/workspaces' })
  assert.equal(listed.statusCode, 200)
  assert.equal((listed.json().workspaces as unknown[]).length, 1)
  const filtered = await fastify.inject({ method: 'GET', url: '/workspaces?hostId=other' })
  assert.equal((filtered.json().workspaces as unknown[]).length, 0)
  const patched = await fastify.inject({ method: 'PATCH', url: `/workspaces/${workspace.id}`, payload: { name: 'tmuxgo2', templateId: null } })
  assert.equal(patched.statusCode, 200)
  assert.equal(patched.json().workspace.name, 'tmuxgo2')
  assert.equal(patched.json().workspace.templateId, null)
  const removed = await fastify.inject({ method: 'DELETE', url: `/workspaces/${workspace.id}` })
  assert.equal(removed.statusCode, 200)
  assert.equal(removed.json().success, true)
  const afterDelete = await fastify.inject({ method: 'GET', url: '/workspaces' })
  assert.equal((afterDelete.json().workspaces as unknown[]).length, 0)
  await fastify.close()
})

test('validates workspace create payloads', () => {
  workspaceCreateBodySchema.parse({ name: 'good-name_1', hostId: 'local', path: '/workspace/x' })
  workspaceCreateBodySchema.parse({ name: '中文工作区', hostId: 'local', path: '/workspace/x' })
  assert.throws(() => workspaceCreateBodySchema.parse({ name: '', hostId: 'local', path: '/workspace/x' }))
  assert.throws(() => workspaceCreateBodySchema.parse({ name: 'ok', hostId: 'local', path: 'relative/path' }))
  assert.throws(() => workspaceCreateBodySchema.parse({ name: 'ok', hostId: '', path: '/workspace/x' }))
})
