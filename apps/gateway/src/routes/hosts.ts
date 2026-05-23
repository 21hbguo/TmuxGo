import type { FastifyInstance } from 'fastify'
import { agentManager } from '../agent-manager.js'

export async function hostRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts', async () => {
    return [
      {
        id: 'local',
        name: 'local-machine',
        address: '127.0.0.1',
        status: 'online',
        tags: ['local'],
      },
      ...agentManager.getAllAgents().map((agent) => ({
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
}
