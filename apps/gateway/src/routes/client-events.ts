import type { FastifyInstance } from 'fastify'
import { appendFile, readFile } from 'fs/promises'

const LOG_PATH = process.env.TMUXGO_CLIENT_EVENTS_LOG || '/tmp/tmuxgo-mobile-debug.ndjson'
const MAX_EVENTS = 160
const MAX_LINE_BYTES = 12000

function trimValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 1000 ? value.slice(0, 1000) : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 40).map(trimValue)
  if (!value || typeof value !== 'object') return undefined
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 80)) next[key] = trimValue(item)
  return next
}

export async function clientEventRoutes(fastify: FastifyInstance) {
  fastify.post('/client-events', async (request, reply) => {
    const body = request.body as { events?: unknown[]; sessionId?: string } | undefined
    const rawEvents = Array.isArray(body?.events) ? body.events.slice(-MAX_EVENTS) : []
    if (rawEvents.length === 0) return { ok: true, count: 0 }
    const receivedAt = new Date().toISOString()
    const ip = request.ip
    const lines = rawEvents.map((event) => {
      const line = JSON.stringify({ receivedAt, ip, sessionId: body?.sessionId || '', event: trimValue(event) })
      return line.length > MAX_LINE_BYTES ? line.slice(0, MAX_LINE_BYTES) : line
    }).join('\n') + '\n'
    await appendFile(LOG_PATH, lines, 'utf8')
    reply.header('cache-control', 'no-store')
    return { ok: true, count: rawEvents.length }
  })
  fastify.get('/client-events/recent', async (_request, reply) => {
    let content = ''
    try {
      content = await readFile(LOG_PATH, 'utf8')
    } catch {}
    const lines = content.trim().split('\n').filter(Boolean).slice(-240)
    reply.header('cache-control', 'no-store')
    return { ok: true, path: LOG_PATH, events: lines.map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { raw: line }
      }
    }) }
  })
}
