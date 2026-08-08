import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { agentManager } from '../agent-manager.js'
import { getAgentEventToken, ingestAgentEvent, isAgentEventToken } from '../lib/agent-events.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import { getHostById } from '../lib/hosts.js'

const identifier = z.string().min(1).max(128)
const eventBody = z.object({
  hostId: identifier,
  provider: identifier.optional(),
  agent: identifier.optional(),
  event: z.record(z.unknown()).optional(),
  payload: z.record(z.unknown()).optional(),
  paneId: z.string().min(3).max(256).optional(),
  tmuxPaneId: z.string().regex(/^%\d+$/).optional(),
  sessionName: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  agentSessionId: z.string().min(1).max(256).optional(),
}).refine((value) => !!value.event !== !!value.payload, { message: 'Exactly one of event or payload is required', path: ['event'] })
function assertPaneBinding(hostId: string, paneId?: string) {
  if (paneId && !paneId.startsWith(`${hostId}:`)) throw new Error('Agent event pane does not belong to host')
}
async function assertHost(hostId: string) {
  if (hostId === 'local' || await getHostById(hostId) || agentManager.getAgentStatus(hostId)) return
  throw new Error('Agent host is not registered')
}
export async function ingestAgentEventRequest(input: unknown, expectedHostId?: string) {
  const body = eventBody.parse(input)
  if (expectedHostId && body.hostId !== expectedHostId) throw new Error('Agent event host does not match connection')
  assertPaneBinding(body.hostId, body.paneId)
  await assertHost(body.hostId)
  const event = ingestAgentEvent(body.event || body.payload, { hostId: body.hostId, provider: body.provider, agent: body.agent, paneId: body.paneId, tmuxPaneId: body.tmuxPaneId, sessionName: body.sessionName, agentSessionId: body.agentSessionId, source: 'protocol' })
  if (!event) throw new Error('Agent event cannot be normalized')
  const applied = agentMonitor.ingestProtocolEvent(event)
  return { event, applied: !!applied }
}
export async function agentEventRoutes(fastify: FastifyInstance) {
  fastify.post('/agent-events', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers))) return reply.code(401).send({ message: 'Agent event token required', code: 'AGENT_EVENT_AUTH_REQUIRED' })
    try {
      const result = await ingestAgentEventRequest(request.body)
      reply.header('cache-control', 'no-store')
      return { accepted: true, eventId: result.event.eventId, applied: result.applied }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid agent event'
      return reply.code(400).send({ message, code: 'INVALID_AGENT_EVENT' })
    }
  })
}
