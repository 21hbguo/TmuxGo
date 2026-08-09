import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { agentManager, type AgentManager } from '../agent-manager.js'

const agentIdParamsSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) })

export async function agentRoutes(fastify: FastifyInstance, options: { agentManager?: AgentManager } = {}) {
  const manager = options.agentManager || agentManager
  fastify.delete('/agents/:id', async (request) => {
    const { id } = agentIdParamsSchema.parse(request.params)
    return { success: manager.removeAgent(id) }
  })
}
