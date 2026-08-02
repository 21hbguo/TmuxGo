import type { WebSocket } from 'ws'

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
class AgentManager {
  private agents = new Map<string, Agent>()
  private history = new Map<string, AgentStatus>()
  register(id: string, name: string, address: string, version: string, socket: WebSocket) {
    const previous = this.agents.get(id)
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
  private toStatus(agent: Agent): AgentStatus {
    const { socket: _socket, ...status } = agent
    if (Date.now() - Date.parse(status.lastSeenAt) <= HEARTBEAT_TIMEOUT_MS) return status
    return { ...status, online: false, lastDisconnectedAt: status.lastSeenAt, disconnectReason: 'Heartbeat timed out' }
  }
}
export const agentManager = new AgentManager()
