import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { appendAuditEvent } from '../lib/audit-log.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import { getRequestPrincipal } from '../lib/principal.js'
import {
  clearDoneAgentTodos,
  getAgentPushPublicKey,
  listAgentTodoQueue,
  listUnreadAgentNotifications,
  reconcileTodoQueue,
  markAgentNotificationsRead,
  normalizeAgentDeviceId,
  registerAgentPushSubscription,
  revokeAgentPushSubscription,
} from '../lib/agent-notifications.js'

const deviceIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/)
const subscriptionBody = z.object({
  deviceId: deviceIdSchema.optional(),
  subscription: z.record(z.string(), z.unknown()),
})
const clearDoneBody = z.object({
  // 缺省=全部 host；给了就只清该 host 的已完成待办
  hostId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .optional(),
})
const readBody = z.object({
  deviceId: deviceIdSchema.optional(),
  ids: z.array(z.string().min(1).max(256)).max(500).optional(),
})
function query(request: FastifyRequest) {
  return request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {}
}
function headerDeviceId(request: FastifyRequest) {
  const value = request.headers['x-tmuxgo-device-id']
  return typeof value === 'string' ? value : undefined
}
function resolveDeviceId(request: FastifyRequest, body?: { deviceId?: unknown }) {
  const values = [body?.deviceId, query(request).deviceId, headerDeviceId(request)].filter(
    (value): value is string => value !== undefined,
  )
  if (!values.length) throw new Error('Device id is required')
  const deviceId = normalizeAgentDeviceId(values[0])
  if (values.some((value) => normalizeAgentDeviceId(value) !== deviceId))
    throw new Error('Device id does not match request')
  return deviceId
}
function sendError(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  return reply.code(400).send({
    message: error instanceof Error ? error.message : 'Invalid notification request',
    code: 'INVALID_AGENT_NOTIFICATION_REQUEST',
  })
}
export async function agentNotificationRoutes(fastify: FastifyInstance) {
  // 待办队列统一入口：store 里的通知是快照，用 monitor 的实时阶段纠正 blocked/pending
  const loadTodoQueue = async (doneLimit = 50) => {
    const live = new Map(agentMonitor.getAllStates().map((state) => [state.paneId, state]))
    return reconcileTodoQueue(await listAgentTodoQueue({ doneLimit }), live)
  }
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
      if (typeof params.id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(params.id))
        throw new Error('Invalid subscription id')
      const deviceId = resolveDeviceId(request)
      return { revoked: await revokeAgentPushSubscription(params.id, deviceId) }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  // 待办队列（agent v2 P2）：按 paneId 聚合的三段视图。
  // 与 /unread 分开是刻意的：unread 是「消息未读数」，语义不变；tasks 是「等谁处理」
  fastify.get('/agent-notifications/tasks', async (request, reply) => {
    try {
      const params = query(request)
      const doneLimit = params.doneLimit === undefined ? 50 : Number(params.doneLimit)
      if (!Number.isInteger(doneLimit) || doneLimit < 1 || doneLimit > 200) throw new Error('Invalid doneLimit')
      reply.header('cache-control', 'no-store')
      return await loadTodoQueue(doneLimit)
    } catch (error) {
      return sendError(reply, error)
    }
  })
  // 清空已完成待办（v2 P3 批量动作的破坏性一个）：只删推导为 done 的记录，
  // blocked/pending 一条不动；响应回 blocked 数，前端据此立刻刷新角标，不用再拉一次 /unread
  fastify.post('/agent-notifications/tasks/clear-done', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const principal = getRequestPrincipal(request)
    const audit = (result: 'success' | 'failure', hostId: string | undefined, message: string) => {
      void appendAuditEvent({
        id: `${Date.now().toString(36)}-${request.id}`,
        timestamp: new Date().toISOString(),
        user: principal.actor,
        actor: principal.actor,
        source: principal.source,
        action: 'agent-todo-clear-done',
        target: hostId || '*',
        result,
        method: request.method,
        statusCode: result === 'success' ? 200 : 400,
        hostId,
        message,
      }).catch(() => {})
    }
    try {
      const body = clearDoneBody.parse(request.body || {})
      const cleared = await clearDoneAgentTodos({ hostId: body.hostId })
      const queue = await loadTodoQueue()
      audit('success', body.hostId, `removed=${cleared.removed};hosts=${cleared.hosts.join(',') || '-'}`)
      reply.header('cache-control', 'no-store')
      return { ok: true, removed: cleared.removed, hosts: cleared.hosts, tasksBlocked: queue.counts.blocked }
    } catch (error) {
      audit('failure', undefined, error instanceof Error ? error.message : 'invalid clear-done request')
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
      const notifications = await listUnreadAgentNotifications(deviceId, limit)
      // 老客户端只读 notifications 字段，语义一个字没变；新字段只增不改
      // blocked 数走同一套队列（含实时纠正），与 /tasks 面板显示的数字必然一致
      const queue = await loadTodoQueue()
      return { notifications, messagesUnread: notifications.length, tasksBlocked: queue.counts.blocked }
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
