import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAgentEventToken, isAgentEventToken } from '../lib/agent-events.js'
import { agentControl, readAgentPane, resolveAgentWaitTarget, splitAgentPane, type AgentWaitCondition, type AgentWaitTarget } from '../lib/agent-control.js'
import { assertTargetAllowed } from '../lib/tmux-policy.js'

const paneIdSchema = z.string().min(3).max(256)
const splitBody = z.object({
  paneId: paneIdSchema,
  direction: z.enum(['horizontal', 'vertical']).default('horizontal'),
  cwd: z.string().max(4096).optional(),
})
const readBody = z.object({
  paneId: paneIdSchema,
  lines: z.number().int().min(1).max(2000).optional(),
})
const waitBody = z.object({
  hostId: z.string().min(1).max(128).optional(),
  target: z.union([
    z.object({ paneId: paneIdSchema }),
    z.object({ sessionName: z.string().min(1).max(64), agent: z.string().min(1).max(64) }),
  ]),
  condition: z.object({
    status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']).optional(),
    phase: z.enum(['idle', 'working', 'needs_input', 'permission_required', 'retrying', 'failed', 'ended', 'disconnected', 'unknown']).optional(),
    lastEvent: z.enum(['started', 'permission_required', 'question_required', 'completed', 'failed', 'retrying', 'ended', 'disconnected', 'reconnected']).optional(),
  }).refine((value) => !!(value.status || value.phase || value.lastEvent), { message: 'condition requires status, phase, or lastEvent' }),
  timeoutMs: z.number().int().min(250).max(600000).optional(),
})
function parseHostPaneId(paneId: string) {
  return resolveAgentWaitTarget({ paneId })
}
export async function agentControlRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/control/panes/split', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers))) return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1') return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = splitBody.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
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
    if (!isAgentEventToken(getAgentEventToken(request.headers))) return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1') return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = readBody.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
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
    if (!isAgentEventToken(getAgentEventToken(request.headers))) return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1') return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = waitBody.parse(request.body)
      const target = body.target as AgentWaitTarget
      const { hostId } = resolveAgentWaitTarget(target, body.hostId || 'local')
      const condition = body.condition as AgentWaitCondition
      const result = await agentControl.wait(target, condition, { hostId, timeoutMs: body.timeoutMs })
      reply.header('cache-control', 'no-store')
      return { ok: true, waitId: result.waitId, elapsedMs: result.elapsedMs, pane: result.pane }
    } catch (error) {
      if (error instanceof Error && 'code' in error && ['OCCUPANT_CHANGED', 'PANE_REMOVED', 'TIMEOUT', 'INVALID_TARGET'].includes((error as { code: string }).code)) {
        return reply.code(409).send({ ok: false, message: error.message, code: (error as { code: string }).code })
      }
      const message = error instanceof Error ? error.message : 'Agent wait failed'
      return reply.code(400).send({ message, code: 'AGENT_CONTROL_WAIT_FAILED' })
    }
  })
}
