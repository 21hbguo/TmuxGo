import { randomUUID } from 'crypto'
import net from 'net'
import path from 'path'
import { readdir, readFile } from 'fs/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import { agentManager, type AgentSocket } from '../agent-manager.js'
import { consumeWebSocketTicket, isAuthEnabled } from '../lib/auth.js'
import { execHostShell, openVncSshTunnel } from '../lib/tmux-executor.js'
import {
  normalizeVncPort,
  parseVncDisplays,
  parseVncProbe,
  vncDisplayStartScript,
  vncDisplayStopScript,
  VNC_DISPLAYS_SCRIPT,
  VNC_INSTALL_SCRIPT,
  VNC_LOOPBACK_HOST,
  VNC_MANUAL_INSTALL_COMMAND,
  VNC_PROBE_COMMAND,
  VNC_START_SCRIPT,
} from '../lib/vnc.js'

type VncSocket = AgentSocket & { close: (code?: number, reason?: string) => void }
type VncDbg = (msg: string, extra?: Record<string, unknown>) => void
const noopDbg: VncDbg = () => {}

// 浏览器 WS 积压超过阈值说明下游消费不动，暂停上游 TCP 读取避免内存膨胀
const WS_PAUSE_THRESHOLD = 8 * 1024 * 1024
const WS_RESUME_THRESHOLD = 2 * 1024 * 1024

function pipeTcpToSocket(tcp: net.Socket, socket: VncSocket, dbg: VncDbg = noopDbg) {
  let resumeTimer: NodeJS.Timeout | null = null
  let bytesIn = 0
  let bytesOut = 0
  tcp.on('connect', () => dbg('vnc tcp connected', { remote: `${tcp.remoteAddress}:${tcp.remotePort}` }))
  tcp.on('data', (chunk) => {
    bytesIn += chunk.length
    if (socket.readyState !== 1) return
    socket.send(chunk)
    if ((socket.bufferedAmount ?? 0) > WS_PAUSE_THRESHOLD && !resumeTimer) {
      dbg('vnc ws backpressure: tcp paused', { bufferedAmount: socket.bufferedAmount })
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
  tcp.on('error', (err) => {
    dbg('vnc tcp error', { error: err.message })
    socket.close(1011, 'VNC server connection failed')
  })
  tcp.on('close', () => {
    dbg('vnc tcp closed', { bytesIn })
    socket.close(1000, 'VNC server closed')
  })
  socket.on('message', (data: Buffer) => {
    bytesOut += data.length
    tcp.write(data)
  })
  socket.on('close', (code: number, reason: Buffer) => {
    dbg('vnc ws closed', { code, reason: reason?.toString(), bytesIn, bytesOut })
    stop()
  })
  socket.on('error', stop)
}

// VNC 排障日志：TMUXGO_VNC_DEBUG=1 才输出，正常跑不打扰日志
const VNC_DEBUG = process.env.TMUXGO_VNC_DEBUG === '1'

export async function vncRoutes(fastify: FastifyInstance) {
  fastify.get('/vnc', { websocket: true }, (connection: SocketStream, request: FastifyRequest) => {
    const socket = connection.socket as unknown as VncSocket
    const dbg: VncDbg = VNC_DEBUG ? (msg, extra) => request.log.info({ vnc: true, ...extra }, msg) : noopDbg
    const query = request.query as { ticket?: unknown; hostId?: unknown; port?: unknown }
    const ticket = typeof query.ticket === 'string' ? query.ticket : ''
    if (isAuthEnabled() && !consumeWebSocketTicket(ticket)) {
      dbg('vnc ws rejected: bad ticket')
      socket.close(1008, 'Authentication required')
      return
    }
    const hostId = typeof query.hostId === 'string' && query.hostId ? query.hostId : 'local'
    const port = normalizeVncPort(query.port)
    if (port === null) {
      dbg('vnc ws rejected: invalid port', { port: query.port })
      socket.close(1008, 'Invalid VNC port')
      return
    }
    dbg('vnc ws accepted', { hostId, port })
    if (hostId === 'local') {
      pipeTcpToSocket(net.connect({ host: VNC_LOOPBACK_HOST, port }), socket, dbg)
      return
    }
    // 远端宿主机优先走 agent 中继：agent 主动拨入 gateway，画面帧以二进制帧复用 agent WS 通道；
    // agent 不在线时回落 ssh -L 端口转发（需要主机配了可用的 SSH 目标），覆盖 SSH-only 部署
    const connectionId = randomUUID()
    if (!agentManager.openVnc(hostId, connectionId, port, socket)) {
      dbg('vnc agent relay refused, trying ssh tunnel', { hostId, connectionId })
      void openVncSshTunnel(hostId, port)
        .then((tunnel) => {
          if (socket.readyState !== 1) {
            tunnel.close()
            return
          }
          dbg('vnc ssh tunnel opened', { hostId, localPort: tunnel.localPort })
          socket.on('close', () => tunnel.close())
          socket.on('error', () => tunnel.close())
          pipeTcpToSocket(net.connect({ host: VNC_LOOPBACK_HOST, port: tunnel.localPort }), socket, dbg)
        })
        .catch((err) => {
          const reason = err instanceof Error ? err.message : 'SSH tunnel failed'
          dbg('vnc ssh tunnel failed', { hostId, error: reason })
          socket.close(1011, `Agent offline; SSH tunnel failed: ${reason.slice(0, 80)}`)
        })
      return
    }
    dbg('vnc agent relay opened', { hostId, connectionId })
    socket.on('message', (data: Buffer) => agentManager.sendVncData(connectionId, data))
    socket.on('close', () => agentManager.closeVnc(connectionId))
    socket.on('error', () => agentManager.closeVnc(connectionId))
  })

  // 空响应探活：前端用它估算浏览器→gateway 的 RTT
  fastify.get('/vnc/ping', async () => ({ ok: true }))

  // 个别移动浏览器对动态 import 的 chunk URL 存在模块缓存毒化死锁(请求根本不发)，
  // 前端检测到 import 超时后改为 fetch 此路由取回文本再走 blob import。hash 随构建变化故按 glob 找
  fastify.get('/vnc/client-module', async (_request, reply) => {
    const dist = process.env.TMUXGO_FRONTEND_DIST || path.resolve(process.cwd(), '../frontend/dist')
    try {
      const name = (await readdir(path.join(dist, 'assets'))).find((f) => /^rfb-[\w-]+\.js$/.test(f))
      if (!name) return reply.code(404).send({ message: 'vnc client module not built' })
      reply.header('cache-control', 'no-store')
      return reply.type('text/javascript').send(await readFile(path.join(dist, 'assets', name)))
    } catch {
      return reply.code(404).send({ message: 'vnc client module unavailable' })
    }
  })

  // 列出目标机 loopback 上在跑的 VNC display（虚拟屏选择器数据源）
  fastify.get('/vnc/displays', async (request: FastifyRequest, reply) => {
    const hostId = String((request.query as { hostId?: unknown }).hostId || 'local')
    try {
      const result = await execHostShell(hostId, VNC_DISPLAYS_SCRIPT, { timeoutMs: 15000 })
      return { displays: parseVncDisplays(result.stdout) }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'VNC display scan failed' })
    }
  })

  // 启停虚拟 display：display 校验为整数防注入，脚本内部再校验端口范围
  fastify.post('/vnc/displays', async (request: FastifyRequest, reply) => {
    const body = request.body as { hostId?: unknown; display?: unknown; action?: unknown }
    const hostId = String(body?.hostId || 'local')
    const display = typeof body?.display === 'number' ? body.display : Number(body?.display)
    const action = body?.action
    if (!Number.isInteger(display) || display < 0 || display > 99) {
      return reply.code(400).send({ error: 'Invalid display number' })
    }
    const port = 5900 + display
    const script =
      action === 'start' ? vncDisplayStartScript(display) : action === 'stop' ? vncDisplayStopScript(port) : null
    if (!script) return reply.code(400).send({ error: 'Invalid display action' })
    try {
      const result = await execHostShell(hostId, script, { timeoutMs: 15000 })
      const probed = await execHostShell(hostId, VNC_DISPLAYS_SCRIPT, { timeoutMs: 15000 })
      return {
        ok:
          result.stdout.includes('__started__') ||
          result.stdout.includes('__stopped__') ||
          result.stdout.includes('__running__'),
        needPassword: result.stdout.includes('__need_password__'),
        noServer: result.stdout.includes('__no_server__'),
        displays: parseVncDisplays(probed.stdout),
      }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'VNC display action failed' })
    }
  })

  // 环境探测：经 execHostShell 在目标机（local/ssh/agent 同一通道）跑只读探测脚本
  fastify.get('/vnc/setup', async (request: FastifyRequest, reply) => {
    const hostId = String((request.query as { hostId?: unknown }).hostId || 'local')
    try {
      const result = await execHostShell(hostId, VNC_PROBE_COMMAND, { timeoutMs: 15000 })
      return { status: parseVncProbe(result.stdout), manualCommand: VNC_MANUAL_INSTALL_COMMAND }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'VNC probe failed' })
    }
  })

  fastify.post('/vnc/setup', async (request: FastifyRequest, reply) => {
    const body = request.body as { hostId?: unknown; action?: unknown }
    const hostId = String(body?.hostId || 'local')
    const action = body?.action
    const script = action === 'install' ? VNC_INSTALL_SCRIPT : action === 'start' ? VNC_START_SCRIPT : null
    if (!script) return reply.code(400).send({ error: 'Invalid VNC setup action' })
    try {
      // 安装最多 120s（apt update 慢），启动 15s 足够
      const result = await execHostShell(hostId, script, { timeoutMs: action === 'install' ? 120000 : 15000 })
      const probed = await execHostShell(hostId, VNC_PROBE_COMMAND, { timeoutMs: 15000 })
      return {
        ok: result.stdout.includes(action === 'install' ? '__installed__' : '__started__'),
        needSudo: result.stdout.includes('__need_sudo__'),
        status: parseVncProbe(probed.stdout),
        output: (result.stdout + result.stderr).trim().slice(0, 2000),
        manualCommand: VNC_MANUAL_INSTALL_COMMAND,
      }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'VNC setup failed' })
    }
  })
}
