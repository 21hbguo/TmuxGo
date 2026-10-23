import type { FastifyInstance } from 'fastify'
import {
  MAX_SYNC_PANES,
  clearSyncMembers,
  normalizeSyncMember,
  parseSyncPaneId,
  readSyncMembers,
  replaceSyncMembers,
  type SyncPaneMember,
} from '../lib/sync-panes.js'
import { resolvePrincipalScope, scopeAllowsHost, scopeAllowsSession } from '../lib/access-scope.js'
import { getRequestPrincipal } from '../lib/principal.js'

// 同步输入广播组：全局单组（对齐 synchronize-panes 的"一组开关"直觉），
// 组状态落 config dir，重连/多客户端看到同一份
export async function syncPaneRoutes(fastify: FastifyInstance) {
  fastify.get('/sync-panes', async () => {
    const panes = await readSyncMembers()
    return { panes, max: MAX_SYNC_PANES }
  })

  fastify.put('/sync-panes', async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>
    // 上限在归一化里再裁一次；这里先挡明显非数组的入参
    if (!Array.isArray(body.panes)) return reply.status(400).send({ message: 'panes: expected an array' })
    const members: SyncPaneMember[] = []
    for (const item of body.panes) {
      const member = normalizeSyncMember(item)
      // 单个 paneId 非法即整单拒绝：静默丢弃会让用户以为已经加入，实际没广播
      if (!member) return reply.status(400).send({ message: 'panes: invalid pane reference' })
      members.push(member)
    }
    if (members.length > MAX_SYNC_PANES)
      return reply.status(400).send({ message: `panes: at most ${MAX_SYNC_PANES} panes` })
    // 广播是写能力：受限身份不得把越权 pane 拉进组（否则后续 input 会写到 allowlist 之外）
    const scope = resolvePrincipalScope(getRequestPrincipal(request))
    if (scope) {
      for (const member of members) {
        const { hostId } = parseSyncPaneId(member.paneId)
        if (!scopeAllowsHost(scope, hostId) || !scopeAllowsSession(scope, hostId, member.sessionName))
          return reply.status(403).send({ message: 'Forbidden', code: 'SCOPE_DENIED' })
      }
    }
    const saved = await replaceSyncMembers(members)
    return { panes: saved, max: MAX_SYNC_PANES }
  })

  fastify.delete('/sync-panes', async () => {
    await clearSyncMembers()
    return { panes: [], max: MAX_SYNC_PANES }
  })
}
