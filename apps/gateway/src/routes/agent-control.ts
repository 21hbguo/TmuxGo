import type { FastifyInstance } from 'fastify'
import { getAgentEventToken, isAgentEventToken } from '../lib/agent-events.js'
import {
  agentControl,
  readAgentPane,
  resolveAgentWaitTarget,
  splitAgentPane,
  type AgentWaitCondition,
  type AgentWaitTarget,
} from '../lib/agent-control.js'
import { controlReadBodySchema, controlSplitBodySchema, controlWaitBodySchema } from '../lib/control-protocol.js'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { getHostById } from '../lib/hosts.js'
import { agentManager } from '../agent-manager.js'
function parseHostPaneId(paneId: string) {
  return resolveAgentWaitTarget({ paneId })
}
async function assertKnownHost(hostId: string) {
  if (hostId !== 'local' && !(await getHostById(hostId)) && !agentManager.getAgent(hostId))
    throw new Error(`Host "${hostId}" is not registered`)
}
export async function agentControlRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/control/panes/split', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1')
      return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = controlSplitBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
      await assertKnownHost(hostId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const createdPaneId = await splitAgentPane(hostId, tmuxPaneId, body.direction, body.cwd)
      reply.header('cache-control', 'no-store')
      return { ok: true, paneId: createdPaneId ? `${hostId}:${createdPaneId}` : undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pane split failed'
      return reply.code(400).send({ message, code: 'AGENT_CONTROL_SPLIT_FAILED' })
    }
  })
  fastify.post('/v1/control/panes/read', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1')
      return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = controlReadBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
      await assertKnownHost(hostId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const output = await readAgentPane(hostId, tmuxPaneId, body.lines)
      reply.header('cache-control', 'no-store')
      return { ok: true, paneId: body.paneId, output }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pane read failed'
      return reply.code(400).send({ message, code: 'AGENT_CONTROL_READ_FAILED' })
    }
  })
  fastify.post('/v1/control/agent/wait', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1')
      return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = controlWaitBodySchema.parse(request.body)
      const target = body.target as AgentWaitTarget
      const { hostId } = resolveAgentWaitTarget(target, body.hostId || 'local')
      await assertKnownHost(hostId)
      const condition = body.condition as AgentWaitCondition
      const result = await agentControl.wait(target, condition, { hostId, timeoutMs: body.timeoutMs })
      reply.header('cache-control', 'no-store')
      return { ok: true, waitId: result.waitId, elapsedMs: result.elapsedMs, pane: result.pane }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        ['OCCUPANT_CHANGED', 'PANE_REMOVED', 'TIMEOUT', 'INVALID_TARGET'].includes((error as { code: string }).code)
      ) {
        return reply.code(409).send({ ok: false, message: error.message, code: (error as { code: string }).code })
      }
      const message = error instanceof Error ? error.message : 'Agent wait failed'
      return reply.code(400).send({ message, code: 'AGENT_CONTROL_WAIT_FAILED' })
    }
  })
}
