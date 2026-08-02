import type { FastifyInstance } from 'fastify'
import { agentManager } from '../agent-manager.js'
import { getHostById, getHostCredentials, listAllHosts, removeRemoteHost, upsertRemoteHost, type HostRecord } from '../lib/hosts.js'
import { execHostShell, verifyHostConnectivity } from '../lib/tmux-executor.js'
import { hostIdParamsSchema, remoteHostBodySchema } from '../lib/request-validation.js'
const hostConnectivity = new Map<string, 'online' | 'offline'>()
async function hostResponse(host: HostRecord, agentIds: Set<string>) {
  const credentials = await getHostCredentials(host.id)
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    status: host.id === 'local' || agentIds.has(host.id) ? 'online' : hostConnectivity.get(host.id) || 'unknown',
    tags: host.id === 'local' ? ['local'] : ['ssh'],
    user: host.user,
    port: host.port,
    auth: host.auth,
    hasPassword: !!(credentials.password || credentials.passwordEnv),
    hasPrivateKey: !!credentials.privateKeyPath,
    usesAgent: host.useAgent,
    jumpHost: host.jumpHost || undefined,
    knownHostsPolicy: host.knownHostsPolicy,
  }
}

export async function hostRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts', async () => {
    const configHosts = await listAllHosts()
    const agentIds = new Set(agentManager.getAllAgents().map((agent) => agent.id))
    const configIds = new Set(configHosts.map((host) => host.id))
    const configEntries = await Promise.all(configHosts.map((host) => hostResponse(host, agentIds)))
    return [
      ...configEntries,
      ...agentManager.getAllAgents().filter((agent) => !configIds.has(agent.id)).map((agent) => ({
        id: agent.id,
        name: agent.name,
        address: agent.address,
        status: 'online',
        tags: ['agent'],
      })),
    ]
  })

  fastify.get('/hosts/:id', async (request) => {
    const { id } = request.params as { id: string }
    const configHost = await getHostById(id)
    if (configHost) {
      return hostResponse(configHost, new Set(agentManager.getAllAgents().map((agent) => agent.id)))
    }
    const agent = agentManager.getAgent(id)

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
      status: 'online',
      tags: ['agent'],
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
      useAgent: body.useAgent,
      jumpHost: body.jumpHost,
      knownHostsPolicy: body.knownHostsPolicy,
    })
    return hostResponse(host, new Set())
  })
  fastify.delete('/hosts/:id', async (request) => {
    const { id } = hostIdParamsSchema.parse(request.params)
    const removed = await removeRemoteHost(id)
    hostConnectivity.delete(id)
    return { success: removed }
  })
  fastify.post('/hosts/:id/test', async (request) => {
    const { id } = hostIdParamsSchema.parse(request.params)
    const result = await verifyHostConnectivity(id)
    hostConnectivity.set(id, result.ok ? 'online' : 'offline')
    return result
  })
  fastify.get('/hosts/:id/github/auth-status', async (request) => {
    const { id } = request.params as { id: string }
    try {
      const { stdout } = await execHostShell(id, `if ! command -v gh >/dev/null 2>&1; then printf '__TMUXGO_GH_MISSING__'; elif gh auth status >/dev/null 2>&1; then printf '__TMUXGO_GH_LOGGED_IN__'; else printf '__TMUXGO_GH_NOT_LOGGED_IN__'; fi`, { timeoutMs: 8000 })
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
