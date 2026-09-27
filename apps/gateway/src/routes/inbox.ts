import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { stat } from 'fs/promises'
import {
  archiveInboxMessages,
  deleteInboxMessages,
  getAssetStream,
  getInboxAsset,
  getInboxMessage,
  listInboxMessages,
  markInboxRead,
  purgeInboxMessages,
  restoreInboxMessages,
  resolveAssetPath,
  type InboxAsset,
  type InboxListView,
} from '../lib/agent-inbox.js'
import { normalizeAgentDeviceId } from '../lib/agent-notifications.js'
import { inboxShareStore, INBOX_SHARE_MAX_MINUTES, INBOX_SHARE_MIN_MINUTES } from '../lib/inbox-shares.js'

// 前端 REST：浏览器经正常登录 auth 访问（/api/* 默认 hook）。
// asset 下载支持 Range（视频 seek），内容类型取受控 metadata，禁嗅探。
const readBodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  deviceId: z.string().min(1).max(128),
  // read=false 标未读（全局语义：清 readAt 与 readBy）
  read: z.boolean().optional().default(true),
})
const deleteBodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
})
const archiveBodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  archived: z.boolean().optional().default(true),
})
const RANGE_RE = /^bytes=(\d+)-(\d*)$/

function contentDispositionName(name: string, disposition: 'attachment' | 'inline' = 'attachment') {
  // RFC 5987 encode，避免引号/非 ASCII 注入 header
  const fallback = name.replace(/[^\w.-]/g, '_').slice(0, 120) || 'file'
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).slice(0, 300)}`
}

// 登录区 /inbox 与公开区 /s/i 共用的 asset 响应：stat + Range + 受控 header。
// disposition=inline 只由分享路由按 MIME 白名单传入，登录区始终 attachment
export async function sendInboxAsset(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  asset: InboxAsset,
  name: string,
  mime: string,
  disposition: 'attachment' | 'inline' = 'attachment',
) {
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
  reply.header('Content-Disposition', contentDispositionName(name, disposition))
  // inline 场景兜底 CSP：即使 MIME 判断失误，sandbox 也能掐掉脚本/表单执行
  if (disposition === 'inline') reply.header('Content-Security-Policy', 'sandbox')
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
      // deviceId 只换取 unreadCount；显式 unread=1 才过滤列表——
      // 之前把 deviceId 映射成过滤导致「已读即消失」
      unreadForDevice: typeof query.deviceId === 'string' ? query.deviceId : undefined,
      unreadOnly: query.unread === '1' || query.unread === 'true',
      // view=active|archived|trash|all；兼容旧 archived=1/all；默认 vista activa
      view:
        query.view === 'archived' || query.view === 'trash' || query.view === 'all'
          ? (query.view as InboxListView)
          : query.archived === '1' || query.archived === 'true'
            ? 'archived'
            : query.archived === 'all'
              ? 'all'
              : undefined,
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
      const body = request.body as Record<string, unknown> | undefined
      const deviceId = normalizeAgentDeviceId(body?.deviceId)
      // read:false 标未读——与批量路由同语义（默认 true 保持兼容）
      const read = body?.read !== false
      const result = await markInboxRead([id], deviceId, read)
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  fastify.post('/inbox/read', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    try {
      const body = readBodySchema.parse(request.body)
      const result = await markInboxRead(body.ids, normalizeAgentDeviceId(body.deviceId), body.read)
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  // 关闭已打开 = archivar（读过的可归档/可恢复；未读的服务端拒绝）——≠删除
  fastify.post('/inbox/archive', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    try {
      const body = archiveBodySchema.parse(request.body)
      const result = await archiveInboxMessages(body.ids, body.archived)
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  // 删除=进回收站（软删可恢复）；restore 回活动/归档态；purge 才物理删除+回收 asset
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
  fastify.post('/inbox/restore', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    try {
      const body = deleteBodySchema.parse(request.body)
      const result = await restoreInboxMessages(body.ids)
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  fastify.post('/inbox/purge', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    try {
      const body = deleteBodySchema.parse(request.body)
      const result = await purgeInboxMessages(body.ids)
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
    }
  })
  // 两种寻址：按 messageId（前端 tab 只有它）与按 assetId（协议文档契约）
  fastify.get('/inbox/:id/asset', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = await getInboxMessage(id)
    if (!message?.assetId) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    const asset = await getInboxAsset(message.assetId)
    if (!asset) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    return sendInboxAsset(request, reply, asset, message.name || asset.name, message.mime || asset.mime)
  })
  fastify.get('/inbox/assets/:assetId', async (request, reply) => {
    const { assetId } = request.params as { assetId: string }
    const asset = await getInboxAsset(assetId)
    if (!asset) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    return sendInboxAsset(request, reply, asset, asset.name, asset.mime)
  })

  // 附件外链管理（登录区内）：显式创建 / 可撤销 / 限时，token 只在创建响应里出现一次
  fastify.post('/inbox/:id/share', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = await getInboxMessage(id)
    if (!message?.assetId) return reply.code(404).send({ message: 'Not found', code: 'INBOX_MESSAGE_NOT_FOUND' })
    const asset = await getInboxAsset(message.assetId)
    if (!asset) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    const expiresInMinutes = Number((request.body as { expiresInMinutes?: unknown } | undefined)?.expiresInMinutes)
    if (
      !Number.isInteger(expiresInMinutes) ||
      expiresInMinutes < INBOX_SHARE_MIN_MINUTES ||
      expiresInMinutes > INBOX_SHARE_MAX_MINUTES
    )
      return reply.code(400).send({
        message: `expiresInMinutes must be between ${INBOX_SHARE_MIN_MINUTES} and ${INBOX_SHARE_MAX_MINUTES}`,
        code: 'INVALID_EXPIRY',
      })
    const { share, token } = await inboxShareStore.create(
      {
        messageId: message.id,
        assetId: asset.id,
        name: message.name || asset.name,
        mime: message.mime || asset.mime,
        size: message.size || asset.size,
      },
      expiresInMinutes,
    )
    return { ok: true, share, path: `/s/i/${token}` }
  })
  fastify.get('/inbox/:id/shares', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = await getInboxMessage(id)
    if (!message) return reply.code(404).send({ message: 'Not found', code: 'INBOX_MESSAGE_NOT_FOUND' })
    return { ok: true, shares: await inboxShareStore.listForMessage(id) }
  })
  fastify.delete('/inbox/shares/:shareId', async (request, reply) => {
    const { shareId } = request.params as { shareId: string }
    if (!shareId || !(await inboxShareStore.revoke(shareId)))
      return reply.code(404).send({ message: 'Share not found', code: 'INBOX_SHARE_NOT_FOUND' })
    return { ok: true }
  })
}
