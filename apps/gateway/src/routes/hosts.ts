import type { FastifyInstance } from 'fastify'
import { agentManager } from '../agent-manager.js'
import { getHostById, listAllHosts, removeRemoteHost, upsertRemoteHost } from '../lib/hosts.js'
import { execHostShell, verifyHostConnectivity } from '../lib/tmux-executor.js'

export async function hostRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts', async () => {
    const configHosts = await listAllHosts()
    const agentIds = new Set(agentManager.getAllAgents().map((agent) => agent.id))
    const configIds = new Set(configHosts.map((host) => host.id))
    const configEntries = configHosts.map((host) => ({
      id: host.id,
      name: host.name,
      address: host.address,
      status: host.id === 'local' ? 'online' : agentIds.has(host.id) ? 'online' : 'offline',
      tags: host.id === 'local' ? ['local'] : ['ssh'],
      user: host.user,
      port: host.port,
      auth: host.auth,
      hasPassword: !!host.password,
      passwordEnv: host.passwordEnv,
    }))
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
      const agent = agentManager.getAgent(id)
      return {
        id: configHost.id,
        name: configHost.name,
        address: configHost.address,
        status: configHost.id === 'local' ? 'online' : agent ? 'online' : 'offline',
        tags: configHost.id === 'local' ? ['local'] : ['ssh'],
        user: configHost.user,
        port: configHost.port,
        auth: configHost.auth,
        hasPassword: !!configHost.password,
        passwordEnv: configHost.passwordEnv,
      }
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
    const body = (request.body || {}) as { id?: string; name?: string; address?: string; user?: string; port?: number; password?: string; passwordEnv?: string }
    if (!body?.id || !body?.address || !body?.user) throw new Error('id,address,user are required')
    const host = await upsertRemoteHost({
      id: body.id,
      name: body.name,
      address: body.address,
      user: body.user,
      port: body.port,
      auth: 'auto',
      password: body.password,
      passwordEnv: body.passwordEnv,
    })
    return {
      id: host.id,
      name: host.name,
      address: host.address,
      status: 'offline',
      tags: ['ssh'],
      user: host.user,
      port: host.port,
      auth: host.auth,
      hasPassword: !!host.password,
      passwordEnv: host.passwordEnv,
    }
  })
  fastify.delete('/hosts/:id', async (request) => {
    const { id } = request.params as { id: string }
    const removed = await removeRemoteHost(id)
    return { success: removed }
  })
  fastify.post('/hosts/:id/test', async (request) => {
    const { id } = request.params as { id: string }
    const result = await verifyHostConnectivity(id)
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
