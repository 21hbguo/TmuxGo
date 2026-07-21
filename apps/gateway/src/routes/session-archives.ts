import type { FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { assertSessionAllowed } from '../lib/tmux-policy.js'
import { parseSessionRef } from '../lib/tmux-target.js'
import { execTmux } from '../lib/tmux-executor.js'

type SessionCaptureMode = 'visible' | 'history'
interface SessionArchivePane {
  paneId: string
  title: string
  windowName: string
  active: boolean
  data: string
}
interface SessionArchive {
  id: string
  hostId: string
  sessionId: string
  sessionName: string
  captureMode: SessionCaptureMode
  createdAt: string
  expiresAt: string
  size: number
  paneCount: number
  panes: SessionArchivePane[]
}
const maxArchiveBytes = 32 * 1024 * 1024
const maxArchiveCount = 100
function getArchiveDir(hostId: string) {
  const root = process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo')
  return path.join(root, 'session-archives', Buffer.from(hostId).toString('base64url'))
}
function normalizeInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback
}
function trimOutput(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ''
  const data = Buffer.from(value, 'utf8')
  if (data.length <= maxBytes) return value
  return data.subarray(data.length - maxBytes).toString('utf8')
}
function isArchive(value: unknown): value is SessionArchive {
  if (!value || typeof value !== 'object') return false
  const archive = value as SessionArchive
  return typeof archive.id === 'string' && typeof archive.hostId === 'string' && typeof archive.sessionId === 'string' && typeof archive.createdAt === 'string' && Array.isArray(archive.panes)
}
async function readArchives(hostId: string) {
  const dir = getArchiveDir(hostId)
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
  } catch {
    return []
  }
  const now = Date.now()
  const archives: SessionArchive[] = []
  for (const name of files) {
    const file = path.join(dir, name)
    try {
      const archive = JSON.parse(await readFile(file, 'utf8'))
      if (!isArchive(archive) || archive.hostId !== hostId || Date.parse(archive.expiresAt) <= now) {
        await rm(file, { force: true })
        continue
      }
      archives.push(archive)
    } catch {
      await rm(file, { force: true })
    }
  }
  archives.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  for (const archive of archives.slice(maxArchiveCount)) await rm(path.join(dir, `${archive.id}.json`), { force: true })
  return archives.slice(0, maxArchiveCount)
}
function toArchiveSummary(archive: SessionArchive) {
  const { panes, ...summary } = archive
  return summary
}
async function captureSessionArchive(hostId: string, sessionId: string, captureMode: SessionCaptureMode, maxBytes: number, retentionDays: number) {
  const sessionName = parseSessionRef(hostId, sessionId).sessionName
  assertSessionAllowed(sessionName)
  const { stdout } = await execTmux(hostId, ['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}\t#{pane_title}\t#{window_name}\t#{pane_active}'])
  const paneRows = stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [tmuxPaneId, title, windowName, active] = line.split('\t')
    return { tmuxPaneId, title: title || 'shell', windowName: windowName || '', active: active === '1' }
  }).filter((pane) => /^%\d+$/.test(pane.tmuxPaneId))
  const bytesPerPane = paneRows.length ? Math.floor(maxBytes / paneRows.length) : 0
  const panes: SessionArchivePane[] = []
  for (const pane of paneRows) {
    const args = ['capture-pane', '-p', '-t', pane.tmuxPaneId]
    if (captureMode === 'history') args.push('-S', '-')
    const { stdout: data } = await execTmux(hostId, args)
    panes.push({ paneId: `${hostId}:${pane.tmuxPaneId}`, title: pane.title, windowName: pane.windowName, active: pane.active, data: trimOutput(data, bytesPerPane) })
  }
  const createdAt = new Date().toISOString()
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const archive: SessionArchive = { id, hostId, sessionId, sessionName, captureMode, createdAt, expiresAt: new Date(Date.now() + retentionDays * 86400000).toISOString(), size: panes.reduce((sum, pane) => sum + Buffer.byteLength(pane.data, 'utf8'), 0), paneCount: panes.length, panes }
  const dir = getArchiveDir(hostId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  const temp = `${file}.tmp-${Date.now()}`
  await writeFile(temp, JSON.stringify(archive), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
  await readArchives(hostId)
  return archive
}
export async function sessionArchiveRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/session-archives', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { sessionId } = request.query as { sessionId?: string }
    const archives = await readArchives(hostId)
    return { archives: archives.filter((archive) => !sessionId || archive.sessionId === sessionId).map(toArchiveSummary) }
  })
  fastify.get('/hosts/:hostId/session-archives/:archiveId', async (request, reply) => {
    const { hostId, archiveId } = request.params as { hostId: string; archiveId: string }
    if (!/^[A-Za-z0-9_-]+$/.test(archiveId)) return reply.code(400).send({ message: 'Invalid archive id' })
    const archive = (await readArchives(hostId)).find((item) => item.id === archiveId)
    if (!archive) return reply.code(404).send({ message: 'Archive not found' })
    return archive
  })
  fastify.post('/hosts/:hostId/session-archives', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const body = request.body as { sessionId?: string; captureMode?: string; maxBytesPerSession?: number; retentionDays?: number }
    if (!body?.sessionId) throw new Error('Missing session id')
    const captureMode = body.captureMode === 'history' ? 'history' : 'visible'
    const maxBytes = normalizeInt(body.maxBytesPerSession, 262144, 0, maxArchiveBytes)
    const retentionDays = normalizeInt(body.retentionDays, 7, 1, 3650)
    return toArchiveSummary(await captureSessionArchive(hostId, body.sessionId, captureMode, maxBytes, retentionDays))
  })
  fastify.delete('/hosts/:hostId/session-archives/:archiveId', async (request, reply) => {
    const { hostId, archiveId } = request.params as { hostId: string; archiveId: string }
    if (!/^[A-Za-z0-9_-]+$/.test(archiveId)) return reply.code(400).send({ message: 'Invalid archive id' })
    const archive = (await readArchives(hostId)).find((item) => item.id === archiveId)
    if (!archive) return reply.code(404).send({ message: 'Archive not found' })
    await rm(path.join(getArchiveDir(hostId), `${archiveId}.json`), { force: true })
    return { ok: true }
  })
}
