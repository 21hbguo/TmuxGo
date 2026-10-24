import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { agentManager } from '../apps/gateway/src/agent-manager.ts'
import { recordHostConnectionFailure } from '../apps/gateway/src/lib/host-connectivity.ts'
import { upsertRemoteHost } from '../apps/gateway/src/lib/hosts.ts'
import { hostRoutes } from '../apps/gateway/src/routes/hosts.ts'

test('configured SSH host keeps SSH status when an Agent with the same id is online', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-routes-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  // register 只保存 socket 引用，测试不发送消息；事件回调返回 undefined 即可
  const socket: Parameters<typeof agentManager.register>[4] = { readyState: 1, send() {}, on: () => undefined }
  agentManager.register('remote', 'remote-agent', '10.0.0.2', '1.0.0', socket)
  const app = Fastify()
  await app.register(hostRoutes, { prefix: '/api' })
  await upsertRemoteHost({
    id: 'remote',
    name: 'remote-ssh',
    address: '10.0.0.2',
    user: 'guo',
    password: 'route-secret',
    privateKeyPath: '/home/user/.ssh/id_ed25519',
    tags: ['production'],
  })
  recordHostConnectionFailure('remote', 'SSH authentication failed')
  t.after(async () => {
    agentManager.unregister('remote', socket)
    await app.close()
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
  })
  const response = await app.inject({ method: 'GET', url: '/api/hosts/remote' })
  assert.equal(response.statusCode, 200)
  const host = response.json()
  assert.equal(host.connectionMode, 'ssh')
  assert.equal(host.status, 'offline')
  assert.equal(host.lastConnectionError, 'SSH authentication failed')
  assert.deepEqual(host.tags, ['ssh', 'production'])
  assert.deepEqual(host.userTags, ['production'])
  assert.equal(host.agent.online, true)
  assert.equal(host.hasPassword, true)
  assert.equal(host.hasPrivateKey, true)
  assert.equal('password' in host, false)
  assert.equal(JSON.stringify(host).includes('route-secret'), false)
  assert.equal(JSON.stringify(host).includes('id_ed25519'), false)
})

// 同机 agent 折叠：loopback 注册的 agent 不再单列 host，状态挂到 local 条目的 agent 字段
test('folds a loopback agent into the local host entry', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-routes-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  const socket: Parameters<typeof agentManager.register>[4] = { readyState: 1, send() {}, on: () => undefined }
  const id = 'agent-local-dedup'
  agentManager.register(id, 'workstation-agent', '192.0.2.11', '1.0.0', socket, undefined, '127.0.0.1')
  const app = Fastify()
  await app.register(hostRoutes, { prefix: '/api' })
  t.after(async () => {
    agentManager.removeAgent(id)
    await app.close()
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
  })
  const hosts = (await app.inject({ method: 'GET', url: '/api/hosts' })).json()
  assert.equal(
    hosts.some((host: { id: string }) => host.id === id),
    false,
  )
  const local = hosts.find((host: { id: string }) => host.id === 'local')
  assert.equal(local.connectionMode, 'local')
  assert.equal(local.agent.id, id)
  assert.equal(local.agent.online, true)
  // 按原 agent id 直查仍然可用（已有调用方依赖）
  const direct = (await app.inject({ method: 'GET', url: `/api/hosts/${id}` })).json()
  assert.equal(direct.id, id)
  assert.equal(direct.connectionMode, 'agent')
  assert.equal(direct.agent.online, true)
})

test('keeps a remote agent as its own host entry', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-routes-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  const socket: Parameters<typeof agentManager.register>[4] = { readyState: 1, send() {}, on: () => undefined }
  const id = 'agent-remote-dedup'
  agentManager.register(id, 'devbox-remote', '198.51.100.7', '1.0.0', socket, undefined, '198.51.100.7')
  const app = Fastify()
  await app.register(hostRoutes, { prefix: '/api' })
  t.after(async () => {
    agentManager.removeAgent(id)
    await app.close()
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
  })
  const hosts = (await app.inject({ method: 'GET', url: '/api/hosts' })).json()
  const remote = hosts.find((host: { id: string }) => host.id === id)
  assert.equal(remote.connectionMode, 'agent')
  assert.equal(remote.status, 'online')
  const local = hosts.find((host: { id: string }) => host.id === 'local')
  assert.notEqual(local.agent?.id, id)
})

// 离线/历史同机 agent 同样折叠：不能因为 agent 掉线就冒出第二条 host
test('keeps folding a same-machine agent after it disconnects', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-routes-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  const socket: Parameters<typeof agentManager.register>[4] = { readyState: 1, send() {}, on: () => undefined }
  const id = 'agent-local-offline-dedup'
  agentManager.register(id, 'devbox-agent', '192.0.2.12', '1.0.0', socket, undefined, '::1')
  agentManager.unregister(id, socket, 'test disconnect')
  const app = Fastify()
  await app.register(hostRoutes, { prefix: '/api' })
  t.after(async () => {
    agentManager.removeAgent(id)
    await app.close()
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
  })
  const hosts = (await app.inject({ method: 'GET', url: '/api/hosts' })).json()
  assert.equal(
    hosts.some((host: { id: string }) => host.id === id),
    false,
  )
  const local = hosts.find((host: { id: string }) => host.id === 'local')
  assert.equal(local.agent.id, id)
  assert.equal(local.agent.online, false)
  assert.equal(local.agent.disconnectReason, 'test disconnect')
})
