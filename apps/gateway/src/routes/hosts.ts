import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { agentManager } from '../agent-manager.js'
import { getHostConnectivity, removeHostConnectivity, setHostConnectivity } from '../lib/host-connectivity.js'
import {
  getCredentialsPath,
  getHostsPath,
  getHostById,
  getHostCredentials,
  listAllHosts,
  readHostConfig,
  removeRemoteHost,
  saveHostConfig,
  upsertRemoteHost,
  type CredentialStoreFile,
  type HostRecord,
  type HostStoreFile,
} from '../lib/hosts.js'
import {
  appendSshConfigHost,
  listSshConfigHosts,
  readSshConfigText,
  resolveSshHostEffective,
  writeSshConfigText,
} from '../lib/ssh-config.js'
import { execHostShell, verifyHostConnectivity } from '../lib/tmux-executor.js'
import { hostIdParamsSchema, remoteHostBodySchema } from '../lib/request-validation.js'
import { taskManager, type TaskExecutionContext, type TaskManager } from '../lib/task-manager.js'
interface HostTestTaskInput {
  hostId: string
}
const hostStoreSchema = z.object({ version: z.literal(2), hosts: z.array(z.record(z.unknown())) })
const credentialStoreSchema = z.object({ version: z.literal(1), credentials: z.record(z.unknown()) })
const hostConfigBodySchema = z.object({
  hosts: hostStoreSchema.optional(),
  credentials: credentialStoreSchema.optional(),
})
const sshConfigBodySchema = z.object({ content: z.string().max(256 * 1024) })
const sshConfigHostBodySchema = z.object({
  alias: z.string().min(1).max(64),
  hostName: z.string().min(1).max(255),
  user: z.string().max(64).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().max(4096).optional(),
})
async function hostResponse(host: HostRecord) {
  const credentials = await getHostCredentials(host.id)
  const agent = agentManager.getAgentStatus(host.id)
  const health = getHostConnectivity(host.id)
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    status: host.id === 'local' ? 'online' : health?.status || 'unknown',
    tags: Array.from(new Set([host.id === 'local' ? 'local' : 'ssh', ...host.tags])),
    userTags: host.tags,
    user: host.user,
    port: host.port,
    auth: host.auth,
    groups: host.groups,
    favorite: host.favorite,
    hasPassword: !!(credentials.password || credentials.passwordEnv),
    hasPrivateKey: !!credentials.privateKeyPath || !!host.identityFile,
    usesAgent: host.useAgent,
    jumpHost: host.jumpHost || undefined,
    knownHostsPolicy: host.knownHostsPolicy,
    connectionMode: host.id === 'local' ? 'local' : 'ssh',
    source: host.source || 'store',
    configFile: host.configFile,
    identityFile: host.identityFile || undefined,
    latencyMs: health?.latencyMs,
    lastCheckedAt: health?.lastCheckedAt,
    lastConnectionError: health?.lastError,
    dependencies: health?.dependencies,
    agent,
  }
}
async function testHostConnectivity(hostId: string, context?: TaskExecutionContext) {
  context?.appendLog(`Testing ${hostId}`)
  const startTime = Date.now()
  const result = await verifyHostConnectivity(hostId)
  const latencyMs = Date.now() - startTime
  let dependencies: Record<string, boolean> | undefined
  if (result.ok) {
    try {
      const { stdout } = await execHostShell(
        hostId,
        `for command in tmux git python3 rg sshpass; do if command -v "$command" >/dev/null 2>&1; then printf '%s=1\n' "$command"; else printf '%s=0\n' "$command"; fi; done`,
        { timeoutMs: 8000 },
      )
      dependencies = Object.fromEntries(
        stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [name, value] = line.split('=')
            return [name, value === '1']
          }),
      )
    } catch {
      // 依赖探测失败不阻断连通性结果
    }
  }
  setHostConnectivity(hostId, {
    status: result.ok ? 'online' : 'offline',
    latencyMs,
    lastCheckedAt: new Date().toISOString(),
    lastError: result.ok ? undefined : result.message,
    dependencies,
  })
  context?.appendLog(result.message)
  return { ...result, latencyMs, dependencies }
}
async function runHostTestTask(input: unknown, context: TaskExecutionContext) {
  const task = input as HostTestTaskInput
  const result = await testHostConnectivity(task.hostId, context)
  if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code || 'CONNECTION_ERROR' })
  return { message: result.message, result: { hostId: task.hostId, ...result } }
}

export async function hostRoutes(fastify: FastifyInstance, options: { taskManager?: TaskManager } = {}) {
  const backgroundTasks = options.taskManager || taskManager
  backgroundTasks.register('host-test', runHostTestTask)
  fastify.get('/hosts', async () => {
    const configHosts = await listAllHosts()
    const configIds = new Set(configHosts.map((host) => host.id))
    const configEntries = await Promise.all(configHosts.map((host) => hostResponse(host)))
    return [
      ...configEntries,
      ...agentManager
        .getAllAgentStatuses()
        .filter((agent) => !configIds.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          address: agent.address,
          status: agent.online ? 'online' : 'offline',
          tags: ['agent'],
          userTags: [],
          connectionMode: 'agent',
          source: 'agent',
          agent,
        })),
    ]
  })

  fastify.get('/hosts/ssh-config', async () => {
    const { path: configPath, content } = await readSshConfigText()
    const hosts = await listSshConfigHosts(configPath)
    return { path: configPath, content, hosts }
  })
  fastify.put('/hosts/ssh-config', async (request, reply) => {
    const body = sshConfigBodySchema.parse(request.body)
    try {
      return await writeSshConfigText(body.content)
    } catch (error) {
      return reply
        .code(400)
        .send({ message: error instanceof Error ? error.message : 'Invalid ssh config', code: 'INVALID_REQUEST' })
    }
  })
  fastify.post('/hosts/ssh-config/hosts', async (request, reply) => {
    const body = sshConfigHostBodySchema.parse(request.body)
    try {
      return await appendSshConfigHost(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid host'
      return reply.code(message.includes('already exists') ? 409 : 400).send({ message, code: 'INVALID_REQUEST' })
    }
  })

  fastify.get('/hosts/config', async () => {
    const { hosts, credentials } = await readHostConfig()
    return { hostsPath: getHostsPath(), credentialsPath: getCredentialsPath(), hosts, credentials }
  })
  fastify.put('/hosts/config', async (request, reply) => {
    const body = hostConfigBodySchema.parse(request.body)
    try {
      return await saveHostConfig(body as { hosts?: HostStoreFile; credentials?: CredentialStoreFile })
    } catch (error) {
      return reply
        .code(400)
        .send({ message: error instanceof Error ? error.message : 'Invalid host config', code: 'INVALID_REQUEST' })
    }
  })

  fastify.get('/hosts/:id', async (request) => {
    const { id } = request.params as { id: string }
    const configHost = await getHostById(id)
    if (configHost) {
      return hostResponse(configHost)
    }
    const agent = agentManager.getAgentStatus(id)

    if (!agent) {
      return {
        id,
        name: id,
        address: 'unknown',
        status: 'offline',
        tags: [],
      }
    }

    return {
      id: agent.id,
      name: agent.name,
      address: agent.address,
      status: agent.online ? 'online' : 'offline',
      tags: ['agent'],
      userTags: [],
      connectionMode: 'agent',
      agent,
    }
  })
  fastify.post('/hosts', async (request) => {
    const body = remoteHostBodySchema.parse(request.body)
    const host = await upsertRemoteHost({
      id: body.id,
      name: body.name,
      address: body.address,
      user: body.user,
      port: body.port,
      auth: 'auto',
      password: body.password,
      passwordEnv: body.passwordEnv,
      privateKeyPath: body.privateKeyPath,
      groups: body.groups,
      tags: body.tags,
      favorite: body.favorite,
      useAgent: body.useAgent,
      jumpHost: body.jumpHost,
      knownHostsPolicy: body.knownHostsPolicy,
    })
    return hostResponse(host)
  })
  fastify.delete('/hosts/:id', async (request) => {
    const { id } = hostIdParamsSchema.parse(request.params)
    const removed = await removeRemoteHost(id)
    removeHostConnectivity(id)
    return { success: removed }
  })
  fastify.post('/hosts/:id/test', async (request) => {
    const { id } = hostIdParamsSchema.parse(request.params)
    return testHostConnectivity(id)
  })
  fastify.get('/hosts/:id/resolve', async (request, reply) => {
    const { id } = hostIdParamsSchema.parse(request.params)
    const host = await getHostById(id)
    if (!host || host.source !== 'sshconfig')
      return reply.code(400).send({ message: 'Host is not backed by ssh config', code: 'INVALID_REQUEST' })
    return resolveSshHostEffective(host.id)
  })
  fastify.post('/hosts/:id/test-tasks', async (request, reply) => {
    const { id } = hostIdParamsSchema.parse(request.params)
    return reply.status(202).send({
      task: await backgroundTasks.start({ type: 'host-test', title: `Test host ${id}`, input: { hostId: id } }),
    })
  })
  fastify.get('/hosts/:id/github/auth-status', async (request) => {
    const { id } = request.params as { id: string }
    try {
      const { stdout } = await execHostShell(
        id,
        `if ! command -v gh >/dev/null 2>&1; then printf '__TMUXGO_GH_MISSING__'; elif gh auth status >/dev/null 2>&1; then printf '__TMUXGO_GH_LOGGED_IN__'; else printf '__TMUXGO_GH_NOT_LOGGED_IN__'; fi`,
        { timeoutMs: 8000 },
      )
      const marker = stdout.trim()
      if (marker === '__TMUXGO_GH_LOGGED_IN__') return { ok: true, available: true, loggedIn: true }
      if (marker === '__TMUXGO_GH_NOT_LOGGED_IN__') return { ok: true, available: true, loggedIn: false }
      if (marker === '__TMUXGO_GH_MISSING__') return { ok: true, available: false, loggedIn: false }
      return { ok: false, available: false, loggedIn: null }
    } catch {
      return { ok: false, available: false, loggedIn: null }
    }
  })
}
