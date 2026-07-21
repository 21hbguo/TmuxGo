import { appendFile, mkdir, readFile, rename, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface AuditEvent {
  id: string
  timestamp: string
  user: string
  action: string
  target: string
  result: 'success' | 'failure'
  method: string
  statusCode: number
  hostId?: string
  message?: string
}
const MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
function getAuditPath() {
  return process.env.TMUXGO_AUDIT_LOG || path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'audit.ndjson')
}
function safeValue(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 256) : ''
}
function getRequestTarget(request: FastifyRequest) {
  const params = request.params as Record<string, unknown> | undefined
  const query = request.query as Record<string, unknown> | undefined
  const body = request.body as Record<string, unknown> | undefined
  const values = [params?.hostId, params?.id, params?.sessionId, params?.windowId, params?.paneId, body?.sessionId, body?.paneId, body?.windowId, body?.path, body?.name, body?.branch, query?.path]
  return values.map(safeValue).filter(Boolean).join(' · ') || request.routeOptions.url || request.url.split('?')[0]
}
function getRequestAction(request: FastifyRequest) {
  const route = (request.routeOptions.url || request.url.split('?')[0]).replace(/^\/api\//, '').replace(/\/:\w+/g, '')
  return `${request.method.toLowerCase()}-${route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}
async function rotateAuditFile(filePath: string) {
  try {
    const info = await stat(filePath)
    if (info.size < MAX_FILE_BYTES) return
    await rename(filePath, `${filePath}.1`)
  } catch {}
}
export async function appendAuditEvent(event: AuditEvent) {
  const filePath = getAuditPath()
  await mkdir(path.dirname(filePath), { recursive: true })
  await rotateAuditFile(filePath)
  await appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
}
export async function recordAuditRequest(request: FastifyRequest, reply: FastifyReply) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
  const statusCode = reply.statusCode
  const event: AuditEvent = {
    id: `${Date.now().toString(36)}-${request.id}`,
    timestamp: new Date().toISOString(),
    user: 'local',
    action: getRequestAction(request),
    target: getRequestTarget(request),
    result: statusCode >= 200 && statusCode < 400 ? 'success' : 'failure',
    method: request.method,
    statusCode,
  }
  const params = request.params as Record<string, unknown> | undefined
  const hostId = safeValue(params?.hostId || params?.id)
  if (hostId) event.hostId = hostId
  if (statusCode >= 400) event.message = reply.statusCode >= 500 ? 'Request failed' : `HTTP ${statusCode}`
  await appendAuditEvent(event).catch(() => {})
}
export async function readAuditEvents(options: { limit?: number | string; action?: string; result?: string; hostId?: string } = {}) {
  const filePath = getAuditPath()
  let content = ''
  try {
    content = await readFile(filePath, 'utf8')
  } catch {}
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(options.limit) || DEFAULT_LIMIT)))
  const action = safeValue(options.action).toLowerCase()
  const result = options.result === 'success' || options.result === 'failure' ? options.result : ''
  const hostId = safeValue(options.hostId)
  return content.trim().split('\n').filter(Boolean).reverse().map((line) => {
    try {
      return JSON.parse(line) as AuditEvent
    } catch {
      return null
    }
  }).filter((event): event is AuditEvent => !!event)
    .filter((event) => !action || event.action.toLowerCase().includes(action))
    .filter((event) => !result || event.result === result)
    .filter((event) => !hostId || event.hostId === hostId)
    .slice(0, limit)
}
