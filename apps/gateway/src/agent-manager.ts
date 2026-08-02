import type { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

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
export interface AgentTerminal {
  id: string
  pid: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (exitCode: number) => void) => void
}
interface AgentTerminalState {
  agentId: string
  socket: WebSocket
  terminal: AgentTerminal
  dataListener: ((data: string) => void) | null
  exitListener: ((exitCode: number) => void) | null
  pendingData: string[]
  exitCode: number | null
}
interface PendingTerminalRequest {
  agentId: string
  socket: WebSocket
  attachmentId: string
  resolve: (terminal: AgentTerminal) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
export interface AgentManagerOptions {
  historyPath?: string | null
}
function getHistoryPath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'agent-history.json')
}
function readHistory(historyPath: string) {
  try {
    const parsed = JSON.parse(readFileSync(historyPath, 'utf8')) as { agents?: unknown }
    if (!Array.isArray(parsed.agents)) return [] as AgentStatus[]
    return parsed.agents.filter((value): value is AgentStatus => !!value && typeof value === 'object' && typeof (value as AgentStatus).id === 'string' && typeof (value as AgentStatus).name === 'string' && typeof (value as AgentStatus).address === 'string' && typeof (value as AgentStatus).version === 'string' && typeof (value as AgentStatus).online === 'boolean' && typeof (value as AgentStatus).lastSeenAt === 'string' && typeof (value as AgentStatus).reconnectCount === 'number').map((value) => ({ ...value, connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : null, lastDisconnectedAt: typeof value.lastDisconnectedAt === 'string' ? value.lastDisconnectedAt : null, disconnectReason: typeof value.disconnectReason === 'string' ? value.disconnectReason : null, reconnectCount: Math.max(0, Math.floor(value.reconnectCount)) }))
  } catch {
    return [] as AgentStatus[]
  }
}
function writeHistory(historyPath: string, agents: AgentStatus[]) {
  try {
    mkdirSync(path.dirname(historyPath), { recursive: true, mode: 0o700 })
    chmodSync(path.dirname(historyPath), 0o700)
    const temporary = `${historyPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ agents })}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, historyPath)
    chmodSync(historyPath, 0o600)
  } catch {}
}
export class AgentManager {
  private readonly historyPath: string | null
  private agents = new Map<string, Agent>()
  private history = new Map<string, AgentStatus>()
  private pendingTmuxRequests = new Map<string, PendingTmuxRequest>()
  private terminals = new Map<string, AgentTerminalState>()
  private pendingTerminalRequests = new Map<string, PendingTerminalRequest>()
  constructor(options: AgentManagerOptions = {}) {
    this.historyPath = options.historyPath === undefined ? getHistoryPath() : options.historyPath
    if (!this.historyPath) return
    const timestamp = new Date().toISOString()
    let changed = false
    for (const status of readHistory(this.historyPath)) {
      if (status.online) {
        status.online = false
        status.connectedAt = null
        status.lastDisconnectedAt = timestamp
        status.disconnectReason = 'Gateway restarted'
        changed = true
      }
      this.history.set(status.id, status)
    }
    if (changed) this.persistHistory()
  }
  register(id: string, name: string, address: string, version: string, socket: WebSocket) {
    const previous = this.agents.get(id)
    if (previous?.socket === socket) {
      previous.name = name
      previous.address = address
      previous.version = version
      previous.lastSeenAt = new Date().toISOString()
      this.history.set(id, this.toStatus(previous))
      this.persistHistory()
      return this.toStatus(previous)
    }
    if (previous && previous.socket !== socket) {
      this.rejectTmuxRequests(id, previous.socket, 'Agent reconnected')
      this.closeTerminals(id, previous.socket, -1)
    }
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
    this.persistHistory()
    console.log(`Agent registered: ${id} (${name})`)
    return this.toStatus(agent)
  }
  unregister(id: string, socket: WebSocket, reason = 'Disconnected') {
    const agent = this.agents.get(id)
    if (!agent || agent.socket !== socket) return false
    this.rejectTmuxRequests(id, socket, `Agent disconnected: ${reason}`)
    this.closeTerminals(id, socket, -1)
    this.agents.delete(id)
    const status: AgentStatus = { ...this.toStatus(agent), online: false, lastDisconnectedAt: new Date().toISOString(), disconnectReason: reason }
    this.history.set(id, status)
    this.persistHistory()
    console.log(`Agent unregistered: ${id}`)
    return true
  }
  heartbeat(id: string, socket: WebSocket, version?: string) {
    const agent = this.agents.get(id)
    if (!agent || agent.socket !== socket) return false
    agent.lastSeenAt = new Date().toISOString()
    if (version) agent.version = version
    this.history.set(id, this.toStatus(agent))
    this.persistHistory()
    return true
  }
  getAgent(id: string) {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    const status = this.toStatus(agent)
    if (!status.online && this.history.get(id)?.online !== false) {
      this.history.set(id, status)
      this.persistHistory()
    }
    return status
  }
  getAgentStatus(id: string) {
    return this.getAgent(id) || this.history.get(id)
  }
  getAllAgents() {
    return Array.from(this.agents.keys()).map((id) => this.getAgent(id)).filter((agent): agent is AgentStatus => !!agent?.online)
  }
  getAllAgentStatuses() {
    const statuses = new Map(this.history)
    for (const agent of this.agents.values()) statuses.set(agent.id, this.getAgent(agent.id)!)
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
  attachTerminal(id: string, sessionName: string, cols: number, rows: number, exclusive: boolean, timeoutMs = 30000) {
    const agent = this.agents.get(id)
    if (!agent || agent.socket.readyState !== 1) return Promise.reject(new Error(`Agent "${id}" is not connected`))
    if (!sessionName || sessionName.length > 256 || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) return Promise.reject(new Error('Invalid Agent terminal attachment'))
    const requestId = randomUUID()
    const attachmentId = randomUUID()
    let state: AgentTerminalState
    const terminal: AgentTerminal = {
      id: attachmentId,
      pid: 0,
      write: (data) => this.sendTerminalInput(state, data),
      resize: (nextCols, nextRows) => this.resizeTerminal(state, nextCols, nextRows),
      kill: () => this.detachTerminal(state),
      onData: (listener) => {
        state.dataListener = listener
        for (const data of state.pendingData.splice(0)) listener(data)
      },
      onExit: (listener) => {
        state.exitListener = listener
        if (state.exitCode !== null) listener(state.exitCode)
      },
    }
    state = { agentId: id, socket: agent.socket, terminal, dataListener: null, exitListener: null, pendingData: [], exitCode: null }
    this.terminals.set(attachmentId, state)
    return new Promise<AgentTerminal>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingTerminalRequests.get(requestId)
        if (!pending) return
        this.pendingTerminalRequests.delete(requestId)
        this.terminals.delete(attachmentId)
        reject(new Error('Agent terminal attachment timed out'))
      }, Math.max(1000, Math.min(timeoutMs, 120000)))
      this.pendingTerminalRequests.set(requestId, { agentId: id, socket: agent.socket, attachmentId, resolve, reject, timer })
      try {
        agent.socket.send(JSON.stringify({ type: 'terminal-attach', requestId, attachmentId, sessionName, cols, rows, exclusive }))
      } catch (error) {
        clearTimeout(timer)
        this.pendingTerminalRequests.delete(requestId)
        this.terminals.delete(attachmentId)
        reject(error instanceof Error ? error : new Error('Failed to send Agent terminal attachment'))
      }
    })
  }
  handleMessage(id: string, socket: WebSocket, message: unknown) {
    if (!message || typeof message !== 'object') return false
    const payload = message as { type?: unknown; requestId?: unknown; attachmentId?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown; pid?: unknown; data?: unknown; exitCode?: unknown }
    if ((payload.type === 'tmux-result' || payload.type === 'tmux-error') && typeof payload.requestId === 'string') {
      const pending = this.pendingTmuxRequests.get(payload.requestId)
      if (!pending || pending.agentId !== id || pending.socket !== socket) return false
      clearTimeout(pending.timer)
      this.pendingTmuxRequests.delete(payload.requestId)
      if (payload.type === 'tmux-error') pending.reject(new Error(typeof payload.message === 'string' && payload.message ? payload.message : 'Agent tmux command failed'))
      else pending.resolve({ stdout: typeof payload.stdout === 'string' ? payload.stdout : '', stderr: typeof payload.stderr === 'string' ? payload.stderr : '' })
      return true
    }
    if ((payload.type === 'terminal-attached' || payload.type === 'terminal-error') && typeof payload.requestId === 'string') {
      const pending = this.pendingTerminalRequests.get(payload.requestId)
      if (!pending || pending.agentId !== id || pending.socket !== socket) return false
      const state = this.terminals.get(pending.attachmentId)
      if (payload.type === 'terminal-error') {
        clearTimeout(pending.timer)
        this.pendingTerminalRequests.delete(payload.requestId)
        this.terminals.delete(pending.attachmentId)
        pending.reject(new Error(typeof payload.message === 'string' && payload.message ? payload.message : 'Agent terminal attachment failed'))
      } else {
        if (payload.attachmentId !== pending.attachmentId || typeof payload.pid !== 'number' || payload.pid <= 0) return false
        clearTimeout(pending.timer)
        this.pendingTerminalRequests.delete(payload.requestId)
        if (!state || state.agentId !== id || state.socket !== socket) {
          pending.reject(new Error('Agent terminal exited before attaching'))
          return true
        }
        state.terminal.pid = payload.pid
        pending.resolve(state.terminal)
      }
      return true
    }
    if ((payload.type === 'terminal-output' || payload.type === 'terminal-exit') && typeof payload.attachmentId === 'string') {
      const state = this.terminals.get(payload.attachmentId)
      if (!state || state.agentId !== id || state.socket !== socket) return false
      if (payload.type === 'terminal-output') {
        if (typeof payload.data !== 'string') return false
        if (state.dataListener) state.dataListener(payload.data)
        else state.pendingData.push(payload.data)
      } else {
        this.terminals.delete(payload.attachmentId)
        state.exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : -1
        state.exitListener?.(state.exitCode)
        for (const [requestId, pending] of this.pendingTerminalRequests) {
          if (pending.attachmentId !== payload.attachmentId) continue
          clearTimeout(pending.timer)
          this.pendingTerminalRequests.delete(requestId)
          pending.reject(new Error('Agent terminal exited before attaching'))
        }
      }
      return true
    }
    return false
  }
  private rejectTmuxRequests(agentId: string, socket: WebSocket, message: string) {
    for (const [requestId, pending] of this.pendingTmuxRequests) {
      if (pending.agentId !== agentId || pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.pendingTmuxRequests.delete(requestId)
      pending.reject(new Error(message))
    }
  }
  private sendTerminalInput(state: AgentTerminalState, data: string) {
    if (!data || state.exitCode !== null || state.socket.readyState !== 1) return
    try {
      state.socket.send(JSON.stringify({ type: 'terminal-input', attachmentId: state.terminal.id, data }))
    } catch {}
  }
  private resizeTerminal(state: AgentTerminalState, cols: number, rows: number) {
    if (state.exitCode !== null || state.socket.readyState !== 1 || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) return
    try {
      state.socket.send(JSON.stringify({ type: 'terminal-resize', attachmentId: state.terminal.id, cols, rows }))
    } catch {}
  }
  private detachTerminal(state: AgentTerminalState) {
    if (this.terminals.get(state.terminal.id) !== state) return
    this.terminals.delete(state.terminal.id)
    if (state.socket.readyState !== 1) return
    try {
      state.socket.send(JSON.stringify({ type: 'terminal-detach', attachmentId: state.terminal.id }))
    } catch {}
  }
  private closeTerminals(agentId: string, socket: WebSocket, exitCode: number) {
    for (const [attachmentId, state] of this.terminals) {
      if (state.agentId !== agentId || state.socket !== socket) continue
      this.terminals.delete(attachmentId)
      state.exitCode = exitCode
      state.exitListener?.(exitCode)
    }
    for (const [requestId, pending] of this.pendingTerminalRequests) {
      if (pending.agentId !== agentId || pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.pendingTerminalRequests.delete(requestId)
      pending.reject(new Error('Agent terminal disconnected'))
    }
  }
  private persistHistory() {
    if (!this.historyPath) return
    const agents = Array.from(this.history.values()).sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)).slice(0, 100)
    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of this.history.keys()) if (!ids.has(id)) this.history.delete(id)
    writeHistory(this.historyPath, agents)
  }
  private toStatus(agent: Agent): AgentStatus {
    const { socket: _socket, ...status } = agent
    if (Date.now() - Date.parse(status.lastSeenAt) <= HEARTBEAT_TIMEOUT_MS) return status
    return { ...status, online: false, lastDisconnectedAt: status.lastSeenAt, disconnectReason: 'Heartbeat timed out' }
  }
}
export const agentManager = new AgentManager()
