import type { FastifyInstance } from 'fastify'
import { getInboxAsset } from '../lib/agent-inbox.js'
import { inboxShareDisposition, inboxShareStore } from '../lib/inbox-shares.js'
import { sendInboxAsset } from './inbox.js'

// 收件箱附件的公开分享入口：路径不在 /api/* 下，故意绕开登录 hook。
// 安全边界：token 为 256bit 随机、限时 + 可撤销 + 绑 auth generation；
// 只对 MIME 白名单放行 inline（见 inboxShareDisposition），其余强制下载。
export async function inboxPublicRoutes(fastify: FastifyInstance) {
  fastify.get('/s/i/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const share = await inboxShareStore.resolve(token)
    if (!share) return reply.code(404).send({ message: 'Share link is unavailable', code: 'INBOX_SHARE_UNAVAILABLE' })
    const asset = await getInboxAsset(share.assetId)
    if (!asset) return reply.code(404).send({ message: 'Not found', code: 'INBOX_ASSET_NOT_FOUND' })
    return sendInboxAsset(request, reply, asset, share.name, share.mime, inboxShareDisposition(share.mime))
  })
}
