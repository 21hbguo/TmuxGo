import type { FastifyInstance } from 'fastify'
import { collectEndpoints, type EndpointsResult } from '../lib/endpoints.js'

interface EndpointsRoutesOptions {
  collect?: (hostId: string) => Promise<EndpointsResult>
}

export async function endpointsRoutes(fastify: FastifyInstance, options: EndpointsRoutesOptions = {}) {
  const collect = options.collect || collectEndpoints
  fastify.get('/endpoints', async () => collect('local'))
  fastify.get('/hosts/:hostId/endpoints', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return collect(hostId)
  })
}
