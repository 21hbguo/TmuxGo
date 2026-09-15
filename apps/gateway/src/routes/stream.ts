import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import { agentManager, type AgentSocket } from '../agent-manager.js'
import { recordStreamMetric, updateStreamMetric } from '../lib/perf-metrics.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import { ingestAgentEvent } from '../lib/agent-events.js'
import {
  streamAttachMessageSchema,
  streamInputMessageSchema,
  streamMessageSchema,
  streamRegisterMessageSchema,
  streamResizeMessageSchema,
} from '../lib/request-validation.js'
import { consumeWebSocketTicket, isAuthEnabled } from '../lib/auth.js'
import { shareLinkStore, type ShareTicket } from '../lib/share-links.js'
import { StreamSession } from '../lib/stream/stream-session.js'
import { STREAM_PING_INTERVAL_MS, STREAM_PONG_TIMEOUT_MS } from '../lib/stream/stream-config.js'
function streamPerfMetricsActiveClientsDelta(delta: number) {
  const next = Math.max(0, Number((globalThis as any).__tmuxgoActiveClients || 0) + delta)
  ;(globalThis as any).__tmuxgoActiveClients = next
  return next
}
export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/stream', { websocket: true }, (connection: SocketStream, request: FastifyRequest) => {
    const query = request.query as { ticket?: unknown }
    const ticket = typeof query.ticket === 'string' ? query.ticket : ''
    const shareTicket: ShareTicket | null = ticket ? shareLinkStore.consumeTicket(ticket) : null
    if (isAuthEnabled() && !shareTicket && !consumeWebSocketTicket(ticket)) {
      connection.socket.close(1008, 'Authentication required')
      return
    }
    console.log('Client connected to stream')
    const socket = connection.socket as unknown as AgentSocket & {
      close: (code?: number, reason?: string) => void
      ping: () => void
      terminate: () => void
    }
    const agentSocket = socket
    const session = new StreamSession(socket, shareTicket)
    let agentId: string | null = null
    const shareStateTimer = shareTicket
      ? setInterval(() => {
          if (shareLinkStore.isTicketActive(shareTicket)) return
          socket.close(1008, 'Share link is unavailable')
        }, 1000)
      : null
    let lastSocketPongAt = Date.now()
    socket.on('pong', () => {
      lastSocketPongAt = Date.now()
    })
    socket.on('error', (err: unknown) => {
      console.error('Stream socket error', err)
      try {
        socket.terminate()
      } catch {}
    })
    const socketPingTimer = setInterval(() => {
      if (socket.readyState !== 1) return
      if (Date.now() - lastSocketPongAt > STREAM_PONG_TIMEOUT_MS) {
        try {
          socket.terminate()
        } catch {}
        return
      }
      try {
        socket.ping()
      } catch {}
    }, STREAM_PING_INTERVAL_MS)
    updateStreamMetric('activeClients', streamPerfMetricsActiveClientsDelta(1))
    socket.on('message', async (message: Buffer) => {
      try {
        const data: any = streamMessageSchema.parse(JSON.parse(message.toString()))
        if (agentId && agentManager.handleMessage(agentId, agentSocket, data)) return
        if (shareTicket) {
          if (!shareLinkStore.isTicketActive(shareTicket)) {
            socket.close(1008, 'Share link is unavailable')
            return
          }
          if (!['attach', 'detach', 'ping', 'stream_profile', 'stream_backpressure'].includes(data.type)) {
            session.send({ type: 'error', code: 'SHARE_READ_ONLY', message: 'Shared terminal is read-only' })
            return
          }
        }
        switch (data.type) {
          case 'register': {
            const register = streamRegisterMessageSchema.parse(data)
            agentId = register.host.id
            agentManager.register(
              register.host.id,
              register.host.name,
              register.host.address,
              register.version || 'unknown',
              agentSocket,
            )
            session.send({ type: 'registered', agentId: register.host.id })
            break
          }
          case 'heartbeat':
            if (agentId)
              agentManager.heartbeat(agentId, agentSocket, typeof data.version === 'string' ? data.version : undefined)
            break
          case 'agent-event': {
            const hasEvent = data.event !== undefined
            const hasPayload = data.payload !== undefined
            if (hasEvent === hasPayload) throw new Error('Exactly one of event or payload is required')
            const payload = hasEvent ? data.event : data.payload
            if (!agentId || typeof payload !== 'object' || !payload || Array.isArray(payload))
              throw new Error('Agent WebSocket is not registered')
            const paneId = typeof data.paneId === 'string' ? data.paneId : undefined
            if (paneId && !paneId.startsWith(`${agentId}:`)) throw new Error('Agent event pane does not belong to host')
            const event = ingestAgentEvent(payload, {
              hostId: agentId,
              provider: typeof data.provider === 'string' ? data.provider : undefined,
              agent: typeof data.agent === 'string' ? data.agent : undefined,
              paneId,
              tmuxPaneId: typeof data.tmuxPaneId === 'string' ? data.tmuxPaneId : undefined,
              sessionName: typeof data.sessionName === 'string' ? data.sessionName : undefined,
              agentSessionId: typeof data.agentSessionId === 'string' ? data.agentSessionId : undefined,
              source: 'protocol',
            })
            if (!event) throw new Error('Agent event cannot be normalized')
            const applied = agentMonitor.ingestProtocolEvent(event)
            session.send({ type: 'agent-event-accepted', eventId: event.eventId, applied: !!applied })
            break
          }
          case 'attach': {
            const attach = streamAttachMessageSchema.parse(data)
            await session.attach(attach)
            break
          }
          case 'resize': {
            const resize = streamResizeMessageSchema.parse(data)
            session.resize(resize.cols, resize.rows)
            break
          }
          case 'redraw':
            session.requestRedraw(data.sessionName, data.hostId)
            break
          case 'input': {
            const input = streamInputMessageSchema.parse(data)
            session.input(input.data)
            break
          }
          case 'agent_seen':
            session.markAgentSeen(String(data.paneId || ''))
            break
          case 'stream_caps':
            session.applyCaps(data)
            break
          case 'cell_resync_request':
            session.requestCellResync()
            break
          case 'stream_profile':
            session.setProfile(data.profile)
            break
          case 'stream_backpressure':
            session.setBackpressure(data.level, !!data.mobile)
            break
          case 'pane_scroll': {
            const scrollLines = Number(data.lines) || 0
            if (scrollLines === 0) break
            session.queueScroll(data.sessionName, data.hostId, scrollLines)
            break
          }
          case 'copy_mode_cancel':
            session.cancelCopyMode(data.sessionName, data.hostId)
            break
          case 'detach':
            session.cleanup(true)
            break
          case 'sessions':
            session.send({ type: 'sessions-list', sessions: data.sessions })
            break
          case 'session-created':
            session.send({ type: 'session-created', session: data.session })
            break
          case 'ping':
            session.send({ type: 'pong', timestamp: data.timestamp || Date.now() })
            break
          default:
            session.send({ type: 'error', message: `Unknown message type: ${data.type}` })
        }
      } catch (err) {
        const errorMessage = err instanceof Error && err.message ? err.message : 'Invalid message format'
        console.error('Stream message error', errorMessage)
        const payload: Record<string, unknown> = { type: 'error', message: errorMessage }
        try {
          const data = JSON.parse(message.toString())
          if (typeof data?.hostId === 'string' && data.hostId.trim()) payload.hostId = data.hostId.trim()
          if (typeof data?.sessionName === 'string' && data.sessionName.trim())
            payload.sessionName = data.sessionName.trim()
        } catch {}
        session.send(payload)
      }
    })
    socket.on('close', (code: number, reason: Buffer) => {
      console.log('Client disconnected from stream')
      clearInterval(socketPingTimer)
      session.cleanup()
      if (shareStateTimer) clearInterval(shareStateTimer)
      unsubscribeAgentMonitor?.()
      unsubscribeAgentMonitor = null
      updateStreamMetric('activeClients', streamPerfMetricsActiveClientsDelta(-1))
      if (agentId) agentManager.unregister(agentId, agentSocket, reason.toString() || `WebSocket closed (${code})`)
    })
    session.send({ type: 'connected', timestamp: Date.now() })
    let unsubscribeAgentMonitor: (() => void) | null = agentMonitor.subscribe((event) => session.send(event))
  })
}
