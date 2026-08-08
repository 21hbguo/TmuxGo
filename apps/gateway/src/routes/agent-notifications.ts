import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getAgentPushPublicKey, listUnreadAgentNotifications, markAgentNotificationsRead, normalizeAgentDeviceId, registerAgentPushSubscription, revokeAgentPushSubscription } from '../lib/agent-notifications.js'

const deviceIdSchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/)
const subscriptionBody = z.object({
  deviceId: deviceIdSchema.optional(),
  subscription: z.record(z.unknown()),
})
const readBody = z.object({
  deviceId: deviceIdSchema.optional(),
  ids: z.array(z.string().min(1).max(256)).max(500).optional(),
})
function query(request: FastifyRequest) {
  return request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {}
}
function headerDeviceId(request: FastifyRequest) {
  const value = request.headers['x-tmuxgo-device-id']
  return typeof value === 'string' ? value : undefined
}
function resolveDeviceId(request: FastifyRequest, body?: { deviceId?: unknown }) {
  const values = [body?.deviceId, query(request).deviceId, headerDeviceId(request)].filter((value): value is string => value !== undefined)
  if (!values.length) throw new Error('Device id is required')
  const deviceId = normalizeAgentDeviceId(values[0])
  if (values.some((value) => normalizeAgentDeviceId(value) !== deviceId)) throw new Error('Device id does not match request')
  return deviceId
}
function sendError(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  return reply.code(400).send({ message: error instanceof Error ? error.message : 'Invalid notification request', code: 'INVALID_AGENT_NOTIFICATION_REQUEST' })
}
export async function agentNotificationRoutes(fastify: FastifyInstance) {
  fastify.get('/agent-notifications/vapid-public-key', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return { publicKey: await getAgentPushPublicKey() }
  })
  fastify.post('/agent-notifications/subscriptions', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    try {
      const body = subscriptionBody.parse(request.body)
      const deviceId = resolveDeviceId(request, body)
      const result = await registerAgentPushSubscription(deviceId, body.subscription)
      reply.header('cache-control', 'no-store')
      return result
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.delete('/agent-notifications/subscriptions/:id', async (request, reply) => {
    try {
      const params = request.params as { id?: unknown }
      if (typeof params.id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(params.id)) throw new Error('Invalid subscription id')
      const deviceId = resolveDeviceId(request)
      return { revoked: await revokeAgentPushSubscription(params.id, deviceId) }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.get('/agent-notifications/unread', async (request, reply) => {
    try {
      const params = query(request)
      const deviceId = resolveDeviceId(request)
      const limit = params.limit === undefined ? 100 : Number(params.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid limit')
      reply.header('cache-control', 'no-store')
      return { notifications: await listUnreadAgentNotifications(deviceId, limit) }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/agent-notifications/read', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    try {
      const body = readBody.parse(request.body || {})
      const deviceId = resolveDeviceId(request, body)
      return { changed: await markAgentNotificationsRead(deviceId, body.ids || []) }
    } catch (error) {
      return sendError(reply, error)
    }
  })
}
