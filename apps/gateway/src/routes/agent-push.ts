import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getAgentEventToken, isAgentEventToken } from '../lib/agent-events.js'
import {
  createPush,
  normalizeRoute,
  requestOpenTarget,
  type InboxMessageType,
  type PushInput,
} from '../lib/agent-inbox.js'

// agent → UI 推送的控制面入口，与 panes/split|read 同一 guard：
// x-tmuxgo-agent-token（或 Bearer）+ x-tmuxgo-env:1。
// JSON: {type,title?,text?,path?|base64?,name?,mime?,route?,source?,open?,dedupeKey?}
// multipart: file 字段为内容，fields 携带同名元数据。
export async function agentPushRoutes(fastify: FastifyInstance) {
  const guard = (request: FastifyRequest) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return { code: 401 as const, message: 'Agent control token required', codeName: 'AGENT_CONTROL_AUTH_REQUIRED' }
    if (request.headers['x-tmuxgo-env'] !== '1')
      return { code: 403 as const, message: 'TMUXGO_ENV=1 guard required', codeName: 'TMUXGO_ENV_GUARD' }
    return null
  }

  fastify.post('/v1/control/push', { bodyLimit: 40 * 1024 * 1024 }, async (request, reply) => {
    const denied = guard(request)
    if (denied) return reply.code(denied.code).send({ message: denied.message, code: denied.codeName })
    try {
      let input: PushInput
      // multipart 由全局插件提供；未注册环境（单测/精简实例）走纯 JSON 分支
      const isMultipart =
        typeof (request as { isMultipart?: () => boolean }).isMultipart === 'function' && request.isMultipart()
      if (isMultipart) {
        const file = await request.file()
        if (!file)
          return reply.code(400).send({ message: 'multipart requires a file field', code: 'AGENT_PUSH_INVALID' })
        const fields = file.fields as Record<string, { value?: unknown } | undefined>
        const field = (name: string) => {
          const item = fields[name]
          return item && 'value' in item ? item.value : undefined
        }
        const buffer = await file.toBuffer()
        input = {
          type: (field('type') as InboxMessageType) || 'file',
          title: field('title'),
          name: file.filename || field('name'),
          mime: file.mimetype || field('mime'),
          route: parseJsonField(field('route')),
          source: parseJsonField(field('source')),
          open: field('open') === 'true' || field('open') === true,
          dedupeKey: field('dedupeKey'),
          declaredSha256: field('sha256'),
          buffer,
        }
      } else {
        input = (request.body || {}) as PushInput
      }
      const { message, deduplicated } = await createPush(input)
      reply.header('cache-control', 'no-store')
      return {
        ok: true,
        deduplicated,
        messageId: message.id,
        assetId: message.assetId,
        createdAt: message.createdAt,
        type: message.type,
        route: message.route,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Push failed'
      return reply.code(400).send({ message, code: 'AGENT_PUSH_FAILED' })
    }
  })

  // 请求 UI 聚焦到指定 host/session/pane：只广播导航事件，不直接操纵浏览器
  fastify.post('/v1/control/open-target', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const denied = guard(request)
    if (denied) return reply.code(denied.code).send({ message: denied.message, code: denied.codeName })
    try {
      const body = (request.body || {}) as { route?: unknown; messageId?: unknown }
      const route = normalizeRoute(body.route)
      await requestOpenTarget(route, typeof body.messageId === 'string' ? body.messageId : undefined)
      reply.header('cache-control', 'no-store')
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Open target failed'
      return reply.code(400).send({ message, code: 'AGENT_OPEN_TARGET_FAILED' })
    }
  })
}
function parseJsonField(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
