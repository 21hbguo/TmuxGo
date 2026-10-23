import type { FastifyInstance } from 'fastify'
import {
  SNAPSHOT_DEADLINE_MS,
  captureSessionSnapshot,
  deleteSnapshot,
  getSnapshot,
  readSnapshots,
  restoreSnapshot,
  toSnapshotSummary,
} from '../lib/session-snapshot.js'

const snapshotIdPattern = /^[A-Za-z0-9_-]+$/

export async function sessionSnapshotRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/session-snapshots', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { sessionId } = request.query as { sessionId?: string }
    const snapshots = await readSnapshots(hostId)
    return {
      // 列表只给摘要：panes 里的尾部内容几十 KB，点开再取
      snapshots: snapshots.filter((item) => !sessionId || item.sessionId === sessionId).map(toSnapshotSummary),
    }
  })
  fastify.get('/hosts/:hostId/session-snapshots/:snapshotId', async (request, reply) => {
    const { hostId, snapshotId } = request.params as { hostId: string; snapshotId: string }
    if (!snapshotIdPattern.test(snapshotId)) return reply.code(400).send({ message: 'Invalid snapshot id' })
    const snapshot = await getSnapshot(hostId, snapshotId)
    if (!snapshot) return reply.code(404).send({ message: 'Snapshot not found' })
    return snapshot
  })
  fastify.post('/hosts/:hostId/session-snapshots', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const body = request.body as { sessionId?: string; withTail?: boolean; deadlineMs?: number }
    if (!body?.sessionId) throw new Error('Missing session id')
    const deadlineMs = Number.isFinite(body.deadlineMs) ? Math.max(1, Number(body.deadlineMs)) : SNAPSHOT_DEADLINE_MS
    const snapshot = await captureSessionSnapshot({
      hostId,
      sessionId: body.sessionId,
      withTail: body.withTail !== false,
      deadlineMs,
    })
    return snapshot
  })
  fastify.delete('/hosts/:hostId/session-snapshots/:snapshotId', async (request, reply) => {
    const { hostId, snapshotId } = request.params as { hostId: string; snapshotId: string }
    if (!snapshotIdPattern.test(snapshotId)) return reply.code(400).send({ message: 'Invalid snapshot id' })
    const snapshot = await getSnapshot(hostId, snapshotId)
    if (!snapshot) return reply.code(404).send({ message: 'Snapshot not found' })
    await deleteSnapshot(hostId, snapshotId)
    return { ok: true }
  })
  // 恢复：只重建结构与 cwd/命令；返回的 panes.scrollbackTail 是「历史回显」预览，进程不会复活
  fastify.post('/hosts/:hostId/session-snapshots/:snapshotId/restore', async (request, reply) => {
    const { hostId, snapshotId } = request.params as { hostId: string; snapshotId: string }
    if (!snapshotIdPattern.test(snapshotId)) return reply.code(400).send({ message: 'Invalid snapshot id' })
    const body = (request.body || {}) as { name?: string; replace?: boolean }
    try {
      return await restoreSnapshot({ hostId, snapshotId, name: body.name, replace: body.replace === true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'Snapshot not found') return reply.code(404).send({ message })
      return reply.code(400).send({ message })
    }
  })
}
