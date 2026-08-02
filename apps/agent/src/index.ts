import WebSocket from 'ws'
import { TmuxManager } from './tmux.js'

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:3001/api/stream'
const RECONNECT_DELAY = 5000
const HEARTBEAT_INTERVAL = 15000
const GATEWAY_USERNAME = process.env.GATEWAY_USERNAME || 'admin'
const GATEWAY_PASSWORD = process.env.GATEWAY_PASSWORD || ''
const AGENT_VERSION = process.env.TMUXGO_AGENT_VERSION || '0.1.0'
function getGatewayHttpBase() {
  const url = new URL(GATEWAY_URL)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = url.pathname.replace(/\/api\/stream\/?$/, '')
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

class Agent {
  private ws: WebSocket | null = null
  private tmux: TmuxManager
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private accessToken = ''
  private refreshToken = ''

  constructor() {
    this.tmux = new TmuxManager()
  }

  async connect() {
    let gatewayUrl = GATEWAY_URL
    try {
      const ticket = await this.getGatewayTicket()
      if (ticket) {
        const url = new URL(GATEWAY_URL)
        url.searchParams.set('ticket', ticket)
        gatewayUrl = url.toString()
      }
    } catch (err) {
      console.error('Gateway authentication failed:', err instanceof Error ? err.message : String(err))
      this.scheduleReconnect()
      return
    }
    const logUrl = new URL(gatewayUrl)
    logUrl.searchParams.delete('ticket')
    console.log(`Connecting to gateway: ${logUrl}`)

    this.ws = new WebSocket(gatewayUrl)

    this.ws.on('open', () => {
      console.log('Connected to gateway')
      this.register()
      this.startHeartbeat()
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString())
        this.handleMessage(message)
      } catch (err) {
        console.error('Failed to parse message:', err)
      }
    })

    this.ws.on('close', () => {
      console.log('Disconnected from gateway')
      this.stopHeartbeat()
      this.scheduleReconnect()
    })

    this.ws.on('error', (err: Error) => {
      console.error('WebSocket error:', err.message)
    })
  }

  private register() {
    this.send({
      type: 'register',
      host: {
        id: process.env.HOST_ID || 'agent-local',
        name: process.env.HOST_NAME || 'local-machine',
        address: '127.0.0.1',
      },
      version: AGENT_VERSION,
    })
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.send({ type: 'heartbeat', version: AGENT_VERSION }), HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'connected':
        return

      case 'registered':
        console.log(`Registered as agent ${message.agentId || process.env.HOST_ID || 'agent-local'}`)
        return

      case 'command':
        await this.handleCommand(message)
        break

      case 'list-sessions':
        await this.listSessions()
        break

      case 'create-session':
        await this.createSession(message.name)
        break

      default:
        console.log('Unknown message type:', message.type)
    }
  }

  private async handleCommand(message: any) {
    const { paneId, command } = message
    try {
      const output = await this.tmux.execute(command)
      this.send({
        type: 'output',
        paneId,
        data: output,
      })
    } catch (err: any) {
      this.send({
        type: 'error',
        paneId,
        message: err.message,
      })
    }
  }

  private async listSessions() {
    try {
      const sessions = await this.tmux.listSessions()
      this.send({
        type: 'sessions',
        sessions,
      })
    } catch (err: any) {
      this.send({
        type: 'error',
        message: err.message,
      })
    }
  }

  private async createSession(name: string) {
    try {
      const session = await this.tmux.createSession(name)
      this.send({
        type: 'session-created',
        session,
      })
    } catch (err: any) {
      this.send({
        type: 'error',
        message: err.message,
      })
    }
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    this.reconnectTimer = setTimeout(() => {
      console.log('Attempting to reconnect...')
      void this.connect()
    }, RECONNECT_DELAY)
  }

  private async getGatewayTicket() {
    const base = getGatewayHttpBase()
    const statusResponse = await fetch(`${base}/api/auth/status`)
    if (!statusResponse.ok) throw new Error(`Gateway status failed: HTTP ${statusResponse.status}`)
    const status = await statusResponse.json() as { enabled?: boolean }
    if (!status.enabled) return ''
    if (!GATEWAY_USERNAME || !GATEWAY_PASSWORD) throw new Error('GATEWAY_USERNAME and GATEWAY_PASSWORD are required')
    if (!this.accessToken || !this.refreshToken) {
      const loginResponse = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: GATEWAY_USERNAME, password: GATEWAY_PASSWORD }) })
      if (!loginResponse.ok) throw new Error(`Gateway login failed: HTTP ${loginResponse.status}`)
      const login = await loginResponse.json() as { accessToken?: string; refreshToken?: string }
      this.accessToken = login.accessToken || ''
      this.refreshToken = login.refreshToken || ''
    }
    let ticketResponse = await fetch(`${base}/api/auth/ws-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${this.accessToken}` } })
    if (ticketResponse.status === 401 && this.refreshToken) {
      const refreshResponse = await fetch(`${base}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: this.refreshToken }) })
      if (!refreshResponse.ok) {
        this.accessToken = ''
        this.refreshToken = ''
        throw new Error(`Gateway refresh failed: HTTP ${refreshResponse.status}`)
      }
      const refreshed = await refreshResponse.json() as { accessToken?: string; refreshToken?: string }
      this.accessToken = refreshed.accessToken || ''
      this.refreshToken = refreshed.refreshToken || ''
      ticketResponse = await fetch(`${base}/api/auth/ws-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${this.accessToken}` } })
    }
    if (!ticketResponse.ok) {
      this.accessToken = ''
      this.refreshToken = ''
      throw new Error(`Gateway ticket failed: HTTP ${ticketResponse.status}`)
    }
    const ticket = await ticketResponse.json() as { ticket?: string }
    if (!ticket.ticket) throw new Error('Gateway did not return a WebSocket ticket')
    return ticket.ticket
  }

  disconnect() {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    if (this.ws) {
      this.ws.close()
    }
  }
}

const agent = new Agent()
agent.connect()

process.on('SIGINT', () => {
  agent.disconnect()
  process.exit(0)
})

process.on('SIGTERM', () => {
  agent.disconnect()
  process.exit(0)
})
