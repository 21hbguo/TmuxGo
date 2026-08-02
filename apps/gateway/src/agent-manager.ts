import type { WebSocket } from 'ws'
import { randomUUID } from 'crypto'

const HEARTBEAT_TIMEOUT_MS = 45000
export interface AgentStatus {
  id: string
  name: string
  address: string
  version: string
  online: boolean
  connectedAt: string | null
  lastSeenAt: string
  lastDisconnectedAt: string | null
  disconnectReason: string | null
  reconnectCount: number
}
interface Agent extends AgentStatus {
  socket: WebSocket
}
interface PendingTmuxRequest {
  agentId: string
  socket: WebSocket
  resolve: (value: { stdout: string; stderr: string }) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
export class AgentManager {
  private agents = new Map<string, Agent>()
  private history = new Map<string, AgentStatus>()
  private pendingTmuxRequests = new Map<string, PendingTmuxRequest>()
  register(id: string, name: string, address: string, version: string, socket: WebSocket) {
    const previous = this.agents.get(id)
    if (previous && previous.socket !== socket) this.rejectTmuxRequests(id, previous.socket, 'Agent reconnected')
    const history = this.history.get(id)
    const timestamp = new Date().toISOString()
    const agent: Agent = {
      id,
      name,
      address,
      version,
      online: true,
      connectedAt: timestamp,
      lastSeenAt: timestamp,
      lastDisconnectedAt: null,
      disconnectReason: null,
      reconnectCount: (history?.reconnectCount || 0) + (previous || history ? 1 : 0),
      socket,
    }
    this.agents.set(id, agent)
    this.history.set(id, this.toStatus(agent))
    console.log(`Agent registered: ${id} (${name})`)
    return this.toStatus(agent)
  }
  unregister(id: string, socket: WebSocket, reason = 'Disconnected') {
    const agent = this.agents.get(id)
    if (!agent || agent.socket !== socket) return false
    this.rejectTmuxRequests(id, socket, `Agent disconnected: ${reason}`)
    this.agents.delete(id)
    const status: AgentStatus = { ...this.toStatus(agent), online: false, lastDisconnectedAt: new Date().toISOString(), disconnectReason: reason }
    this.history.set(id, status)
    console.log(`Agent unregistered: ${id}`)
    return true
  }
  heartbeat(id: string, socket: WebSocket, version?: string) {
    const agent = this.agents.get(id)
    if (!agent || agent.socket !== socket) return false
    agent.lastSeenAt = new Date().toISOString()
    if (version) agent.version = version
    this.history.set(id, this.toStatus(agent))
    return true
  }
  getAgent(id: string) {
    const agent = this.agents.get(id)
    return agent ? this.toStatus(agent) : undefined
  }
  getAgentStatus(id: string) {
    return this.getAgent(id) || this.history.get(id)
  }
  getAllAgents() {
    return Array.from(this.agents.values()).map((agent) => this.toStatus(agent)).filter((agent) => agent.online)
  }
  getAllAgentStatuses() {
    const statuses = new Map(this.history)
    for (const agent of this.agents.values()) statuses.set(agent.id, this.toStatus(agent))
    return Array.from(statuses.values()).sort((left, right) => left.name.localeCompare(right.name))
  }
  executeTmux(id: string, args: string[], timeoutMs = 30000) {
    const agent = this.agents.get(id)
    if (!agent || agent.socket.readyState !== 1) return Promise.reject(new Error(`Agent "${id}" is not connected`))
    if (!Array.isArray(args) || !args.length || args.length > 64 || args.some((item) => typeof item !== 'string' || item.length > 4096)) return Promise.reject(new Error('Invalid tmux arguments'))
    const requestId = randomUUID()
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingTmuxRequests.get(requestId)
        if (!pending) return
        this.pendingTmuxRequests.delete(requestId)
        reject(new Error('Agent tmux command timed out'))
      }, Math.max(1000, Math.min(timeoutMs, 120000)))
      this.pendingTmuxRequests.set(requestId, { agentId: id, socket: agent.socket, resolve, reject, timer })
      try {
        agent.socket.send(JSON.stringify({ type: 'tmux', requestId, args }))
      } catch (error) {
        clearTimeout(timer)
        this.pendingTmuxRequests.delete(requestId)
        reject(error instanceof Error ? error : new Error('Failed to send Agent tmux command'))
      }
    })
  }
  handleMessage(id: string, socket: WebSocket, message: unknown) {
    if (!message || typeof message !== 'object') return false
    const payload = message as { type?: unknown; requestId?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }
    if ((payload.type !== 'tmux-result' && payload.type !== 'tmux-error') || typeof payload.requestId !== 'string') return false
    const pending = this.pendingTmuxRequests.get(payload.requestId)
    if (!pending || pending.agentId !== id || pending.socket !== socket) return false
    clearTimeout(pending.timer)
    this.pendingTmuxRequests.delete(payload.requestId)
    if (payload.type === 'tmux-error') pending.reject(new Error(typeof payload.message === 'string' && payload.message ? payload.message : 'Agent tmux command failed'))
    else pending.resolve({ stdout: typeof payload.stdout === 'string' ? payload.stdout : '', stderr: typeof payload.stderr === 'string' ? payload.stderr : '' })
    return true
  }
  private rejectTmuxRequests(agentId: string, socket: WebSocket, message: string) {
    for (const [requestId, pending] of this.pendingTmuxRequests) {
      if (pending.agentId !== agentId || pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.pendingTmuxRequests.delete(requestId)
      pending.reject(new Error(message))
    }
  }
  private toStatus(agent: Agent): AgentStatus {
    const { socket: _socket, ...status } = agent
    if (Date.now() - Date.parse(status.lastSeenAt) <= HEARTBEAT_TIMEOUT_MS) return status
    return { ...status, online: false, lastDisconnectedAt: status.lastSeenAt, disconnectReason: 'Heartbeat timed out' }
  }
}
export const agentManager = new AgentManager()
