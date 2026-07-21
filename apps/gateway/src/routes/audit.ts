import type { FastifyInstance } from 'fastify'
import { readAuditEvents } from '../lib/audit-log.js'

export async function auditRoutes(fastify: FastifyInstance) {
  fastify.get('/audit-log', async (request, reply) => {
    const query = request.query as { limit?: string; action?: string; result?: string; hostId?: string }
    reply.header('cache-control', 'no-store')
    const events = await readAuditEvents(query)
    return { events }
  })
}
