import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import test from 'node:test'
import { TaskManager } from '../lib/task-manager.js'
import { hostRoutes } from './hosts.js'

async function waitForTask(manager: TaskManager, id: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const task = manager.get(id)
    if (task && task.status !== 'running') return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Task did not finish')
}
test('runs host diagnostics as a persistent task and keeps the synchronous endpoint', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-route-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  const manager = new TaskManager({ statePath: path.join(configDir, 'tasks.json') })
  const fastify = Fastify()
  await fastify.register(hostRoutes, { taskManager: manager })
  const started = await fastify.inject({ method: 'POST', url: '/hosts/local/test-tasks' })
  assert.equal(started.statusCode, 202)
  const taskId = (started.json() as { task: { id: string } }).task.id
  const completed = await waitForTask(manager, taskId)
  assert.equal(completed.status, 'success')
  assert.equal(completed.result && typeof completed.result === 'object' ? (completed.result as { hostId?: string }).hostId : null, 'local')
  const persisted = JSON.parse(await readFile(path.join(configDir, 'tasks.json'), 'utf8')) as { tasks: { id: string; status: string }[] }
  assert.equal(persisted.tasks[0]?.id, taskId)
  assert.equal(persisted.tasks[0]?.status, 'success')
  const host = await fastify.inject({ method: 'GET', url: '/hosts/local' })
  assert.equal(host.statusCode, 200)
  assert.equal((host.json() as { status: string }).status, 'online')
  const synchronous = await fastify.inject({ method: 'POST', url: '/hosts/local/test' })
  assert.equal(synchronous.statusCode, 200)
  assert.equal((synchronous.json() as { ok: boolean }).ok, true)
  await fastify.close()
})
