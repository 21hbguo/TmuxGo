import { randomUUID } from 'crypto'
import net from 'net'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import { agentManager, type AgentSocket } from '../agent-manager.js'
import { consumeWebSocketTicket, isAuthEnabled } from '../lib/auth.js'
import { normalizeVncPort, VNC_LOOPBACK_HOST } from '../lib/vnc.js'

type VncSocket = AgentSocket & { close: (code?: number, reason?: string) => void }

// 浏览器 WS 积压超过阈值说明下游消费不动，暂停上游 TCP 读取避免内存膨胀
const WS_PAUSE_THRESHOLD = 8 * 1024 * 1024
const WS_RESUME_THRESHOLD = 2 * 1024 * 1024

function pipeTcpToSocket(tcp: net.Socket, socket: VncSocket) {
  let resumeTimer: NodeJS.Timeout | null = null
  tcp.on('data', (chunk) => {
    if (socket.readyState !== 1) return
    socket.send(chunk)
    if ((socket.bufferedAmount ?? 0) > WS_PAUSE_THRESHOLD && !resumeTimer) {
      tcp.pause()
      resumeTimer = setInterval(() => {
        if (socket.readyState !== 1) return
        if ((socket.bufferedAmount ?? 0) <= WS_RESUME_THRESHOLD) {
          if (resumeTimer) clearInterval(resumeTimer)
          resumeTimer = null
          tcp.resume()
        }
      }, 50)
    }
  })
  const stop = () => {
    if (resumeTimer) clearInterval(resumeTimer)
    tcp.destroy()
  }
  tcp.on('error', () => socket.close(1011, 'VNC server connection failed'))
  tcp.on('close', () => socket.close(1000, 'VNC server closed'))
  socket.on('message', (data: Buffer) => tcp.write(data))
  socket.on('close', stop)
  socket.on('error', stop)
}

export async function vncRoutes(fastify: FastifyInstance) {
  fastify.get('/vnc', { websocket: true }, (connection: SocketStream, request: FastifyRequest) => {
    const socket = connection.socket as unknown as VncSocket
    const query = request.query as { ticket?: unknown; hostId?: unknown; port?: unknown }
    const ticket = typeof query.ticket === 'string' ? query.ticket : ''
    if (isAuthEnabled() && !consumeWebSocketTicket(ticket)) {
      socket.close(1008, 'Authentication required')
      return
    }
    const hostId = typeof query.hostId === 'string' && query.hostId ? query.hostId : 'local'
    const port = normalizeVncPort(query.port)
    if (port === null) {
      socket.close(1008, 'Invalid VNC port')
      return
    }
    if (hostId === 'local') {
      pipeTcpToSocket(net.connect({ host: VNC_LOOPBACK_HOST, port }), socket)
      return
    }
    // 远端宿主机只走 agent 中继：agent 是主动拨入 gateway 的，gateway 无法反向连其内网；
    // 由 agent 在宿主机本机拨 loopback VNC，数据以 base64 包进 agent JSON 通道
    const connectionId = randomUUID()
    if (!agentManager.openVnc(hostId, connectionId, port, socket)) {
      socket.close(1011, 'Host is offline or has no agent connected')
      return
    }
    socket.on('message', (data: Buffer) => agentManager.sendVncData(connectionId, data))
    socket.on('close', () => agentManager.closeVnc(connectionId))
    socket.on('error', () => agentManager.closeVnc(connectionId))
  })
}
