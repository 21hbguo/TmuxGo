import type { WebSocket } from 'ws'

interface Agent {
  id: string
  name: string
  address: string
  socket: WebSocket
  lastSeen: Date
}

class AgentManager {
  private agents: Map<string, Agent> = new Map()

  register(id: string, name: string, address: string, socket: WebSocket) {
    this.agents.set(id, {
      id,
      name,
      address,
      socket,
      lastSeen: new Date(),
    })
    console.log(`Agent registered: ${id} (${name})`)
  }

  unregister(id: string) {
    this.agents.delete(id)
    console.log(`Agent unregistered: ${id}`)
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values())
  }

  updateLastSeen(id: string) {
    const agent = this.agents.get(id)
    if (agent) {
      agent.lastSeen = new Date()
    }
  }
}

export const agentManager = new AgentManager()
