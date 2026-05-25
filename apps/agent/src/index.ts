import WebSocket from 'ws'
import { TmuxManager } from './tmux.js'

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:3001/api/stream'
const RECONNECT_DELAY = 5000

class Agent {
  private ws: WebSocket | null = null
  private tmux: TmuxManager
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor() {
    this.tmux = new TmuxManager()
  }

  connect() {
    console.log(`Connecting to gateway: ${GATEWAY_URL}`)

    this.ws = new WebSocket(GATEWAY_URL)

    this.ws.on('open', () => {
      console.log('Connected to gateway')
      this.register()
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
    })
  }

  private async handleMessage(message: any) {
    switch (message.type) {
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
      this.connect()
    }, RECONNECT_DELAY)
  }

  disconnect() {
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
