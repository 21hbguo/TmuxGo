import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { stat } from 'fs/promises'
import {
  deleteInboxMessages,
  getAssetStream,
  getInboxAsset,
  getInboxMessage,
  listInboxMessages,
  markInboxRead,
  resolveAssetPath,
} from '../lib/agent-inbox.js'
import { normalizeAgentDeviceId } from '../lib/agent-notifications.js'

// 前端 REST：浏览器经正常登录 auth 访问（/api/* 默认 hook）。
// asset 下载支持 Range（视频 seek），内容类型取受控 metadata，禁嗅探。
const readBodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  deviceId: z.string().min(1).max(128),
})
const deleteBodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
})
const RANGE_RE = /^bytes=(\d+)-(\d*)$/

function contentDispositionName(name: string) {
  // RFC 5987 encode，避免引号/非 ASCII 注入 header
  const fallback = name.replace(/[^\w.-]/g, '_').slice(0, 120) || 'file'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).slice(0, 300)}`
}

export async function inboxRoutes(fastify: FastifyInstance) {
  fastify.get('/inbox', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const result = await listInboxMessages({
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
      limit:
        typeof query.limit === 'string'
          ? Number(query.limit)
          : typeof query.limit === 'number'
            ? query.limit
            : undefined,
      unreadForDevice: typeof query.deviceId === 'string' ? query.deviceId : undefined,
      sessionName: typeof query.sessionName === 'string' ? query.sessionName : undefined,
      paneId: typeof query.paneId === 'string' ? query.paneId : undefined,
    })
    reply.header('cache-control', 'no-store')
    return { ok: true, ...result }
  })
  fastify.get('/inbox/unread-count', async (request, reply) => {
    const deviceId = (request.query as Record<string, unknown>).deviceId
    try {
      const result = await listInboxMessages({ unreadForDevice: normalizeAgentDeviceId(deviceId), limit: 1 })
      return { ok: true, unreadCount: result.unreadCount ?? 0 }
    } catch {
      return reply.code(400).send({ message: 'Invalid device id', code: 'INVALID_DEVICE_ID' })
    }
  })
  fastify.get('/inbox/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = await getInboxMessage(id)
    if (!message) return reply.code(404).send({ message: 'Not found', code: 'INBOX_MESSAGE_NOT_FOUND' })
    reply.header('cache-control', 'no-store')
    return { ok: true, message }
  })
  fastify.post('/inbox/:id/read', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const deviceId = normalizeAgentDeviceId((request.body as Record<string, unknown>)?.deviceId)
      const result = await markInboxRead([id], deviceId)
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  fastify.post('/inbox/read', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    try {
      const body = readBodySchema.parse(request.body)
      const result = await markInboxRead(body.ids, normalizeAgentDeviceId(body.deviceId))
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  fastify.post('/inbox/delete', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    try {
      const body = deleteBodySchema.parse(request.body)
      const result = await deleteInboxMessages(body.ids)
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  const sendAsset = async (
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    asset: NonNullable<Awaited<ReturnType<typeof getInboxAsset>>>,
    name: string,
    mime: string,
  ) => {
    let resolved: string
    try {
      resolved = resolveAssetPath(asset)
    } catch {
      return reply.code(500).send({ message: 'Invalid asset path', code: 'INBOX_ASSET_PATH_INVALID' })
    }
    const info = await stat(resolved).catch(() => null)
    if (!info?.isFile()) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    reply.header('Content-Type', mime)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Disposition', contentDispositionName(name))
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'private, max-age=3600')
    const rangeHeader = request.headers.range
    const match = typeof rangeHeader === 'string' ? RANGE_RE.exec(rangeHeader) : null
    if (match) {
      const start = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
      if (Number.isFinite(start) && start >= 0 && end >= start && start < info.size) {
        reply.code(206)
        reply.header('Content-Range', `bytes ${start}-${end}/${info.size}`)
        reply.header('Content-Length', end - start + 1)
        return reply.send(await getAssetStream(asset, { start, end }))
      }
      return reply.code(416).send({ message: 'Range not satisfiable', code: 'RANGE_NOT_SATISFIABLE' })
    }
    reply.header('Content-Length', info.size)
    return reply.send(await getAssetStream(asset))
  }
  // 两种寻址：按 messageId（前端 tab 只有它）与按 assetId（协议文档契约）
  fastify.get('/inbox/:id/asset', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = await getInboxMessage(id)
    if (!message?.assetId) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    const asset = await getInboxAsset(message.assetId)
    if (!asset) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    return sendAsset(request, reply, asset, message.name || asset.name, message.mime || asset.mime)
  })
  fastify.get('/inbox/assets/:assetId', async (request, reply) => {
    const { assetId } = request.params as { assetId: string }
    const asset = await getInboxAsset(assetId)
    if (!asset) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    return sendAsset(request, reply, asset, asset.name, asset.mime)
  })
}
