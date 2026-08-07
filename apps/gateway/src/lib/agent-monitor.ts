import { agentManager } from '../agent-manager.js'
import { listAllHosts } from './hosts.js'
import { forgetAgentPane, getHostAgentPanes, markAgentPaneSeen, type AgentEvent, type AgentPaneState } from './agent-state.js'

export type AgentMonitorEvent =
  | { type: 'agent_status_snapshot'; initial: true; hostId: string; revision: number; agents: AgentPaneState[]; eventId: string }
  | { type: 'agent_status_changed'; initial: boolean; hostId: string; sessionName: string; pane: AgentPaneState; eventId: string }
  | { type: 'agent_status_removed'; initial: boolean; hostId: string; paneId: string; sessionName: string; reason: string; eventId: string }
  | { type: 'agent_notification'; initial: false; hostId: string; sessionName: string; pane: AgentPaneState; eventId: string }
  | { type: 'agent_monitor_error'; initial: false; hostId: string; message: string; retrying: true }

interface MonitorHostState {
  agents: Map<string, AgentPaneState>
  revision: number
  initialized: boolean
  disconnected: boolean
  scanning: boolean
  timer: ReturnType<typeof setInterval> | null
}
interface AgentMonitorOptions {
  scan?: (hostId: string) => Promise<AgentPaneState[]>
  getHostIds?: () => Promise<string[]>
  intervalMs?: number
  hostRefreshMs?: number
  now?: () => number
}

const notificationEvents = new Set<AgentEvent>(['permission_required', 'question_required', 'completed', 'failed', 'ended', 'disconnected'])

function sortAgents(agents: Iterable<AgentPaneState>) {
  return [...agents].sort((left, right) => left.paneId.localeCompare(right.paneId))
}
function samePane(left: AgentPaneState | undefined, right: AgentPaneState) {
  if (!left) return false
  return left.paneId === right.paneId && left.tmuxPaneId === right.tmuxPaneId && left.sessionName === right.sessionName && left.agent === right.agent && left.agentSessionId === right.agentSessionId && left.agentStatus === right.agentStatus && left.phase === right.phase && left.lastEvent === right.lastEvent && left.source === right.source && left.confidence === right.confidence && left.since === right.since && left.updatedAt === right.updatedAt && left.eventId === right.eventId && left.message === right.message && left.revision === right.revision
}

export class AgentMonitor {
  private readonly scan: (hostId: string) => Promise<AgentPaneState[]>
  private readonly getHostIds: () => Promise<string[]>
  private readonly intervalMs: number
  private readonly hostRefreshMs: number
  private readonly now: () => number
  private readonly hosts = new Map<string, MonitorHostState>()
  private readonly listeners = new Set<(event: AgentMonitorEvent) => void>()
  private hostRefreshTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private startPromise: Promise<void> | null = null

  constructor(options: AgentMonitorOptions = {}) {
    this.scan = options.scan || ((hostId) => getHostAgentPanes(hostId))
    this.getHostIds = options.getHostIds || (async () => {
      const hosts = await listAllHosts()
      const ids = new Set(hosts.map((host) => host.id))
      for (const agent of agentManager.getAllAgentStatuses()) ids.add(agent.id)
      return [...ids]
    })
    this.intervalMs = Math.max(250, options.intervalMs || 1500)
    this.hostRefreshMs = Math.max(this.intervalMs, options.hostRefreshMs || 5000)
    this.now = options.now || (() => Date.now())
  }

  async start() {
    if (this.running) return this.startPromise || Promise.resolve()
    this.running = true
    this.startPromise = (async () => {
      await this.refreshHosts(false)
      await Promise.all([...this.hosts.keys()].map((hostId) => this.pollHost(hostId)))
      if (this.running) this.hostRefreshTimer = setInterval(() => void this.refreshHosts(), this.hostRefreshMs)
    })()
    try { await this.startPromise } finally { this.startPromise = null }
  }

  stop() {
    this.running = false
    if (this.hostRefreshTimer) clearInterval(this.hostRefreshTimer)
    this.hostRefreshTimer = null
    for (const state of this.hosts.values()) {
      if (state.timer) clearInterval(state.timer)
      state.timer = null
      state.scanning = false
    }
    for (const pane of [...this.hosts.values()].flatMap((state) => [...state.agents.values()])) forgetAgentPane(pane.paneId)
    this.hosts.clear()
  }

  subscribe(listener: (event: AgentMonitorEvent) => void) {
    this.listeners.add(listener)
    for (const [hostId, state] of this.hosts) if (state.initialized) this.emitSnapshot(listener, hostId, state)
    if (!this.running) void this.start()
    return () => this.listeners.delete(listener)
  }

  getStates(hostId: string) {
    const state = this.hosts.get(hostId)
    return state?.initialized ? sortAgents(state.agents.values()) : null
  }

  getSessionStates(hostId: string, sessionName: string) {
    return this.getStates(hostId)?.filter((pane) => pane.sessionName === sessionName) ?? null
  }

  async pollNow(hostId: string) {
    await this.pollHost(hostId)
  }

  markSeen(paneId: string) {
    for (const [hostId, state] of this.hosts) {
      const current = state.agents.get(paneId)
      if (!current) continue
      const pane = markAgentPaneSeen(paneId)
      if (!pane || samePane(current, pane)) return null
      state.agents.set(paneId, pane)
      state.revision += 1
      const event: AgentMonitorEvent = { type: 'agent_status_changed', initial: false, hostId, sessionName: pane.sessionName, pane, eventId: this.eventId(hostId, pane, 'seen', state.revision) }
      this.emit(event)
      return pane
    }
    return null
  }

  private async refreshHosts(pollNewHosts = true) {
    let hostIds: string[]
    try {
      hostIds = await this.getHostIds()
    } catch {
      return
    }
    if (!this.running) return
    const nextIds = new Set(hostIds.filter((hostId) => typeof hostId === 'string' && hostId.trim()))
    for (const hostId of nextIds) {
      if (this.hosts.has(hostId)) continue
      const state: MonitorHostState = { agents: new Map(), revision: 0, initialized: false, disconnected: false, scanning: false, timer: null }
      this.hosts.set(hostId, state)
      if (this.running) {
        state.timer = setInterval(() => void this.pollHost(hostId), this.intervalMs)
        if (pollNewHosts) void this.pollHost(hostId)
      }
    }
    for (const [hostId, state] of this.hosts) {
      if (nextIds.has(hostId)) continue
      if (state.timer) clearInterval(state.timer)
      for (const pane of state.agents.values()) {
        forgetAgentPane(pane.paneId)
        this.emit({ type: 'agent_status_removed', initial: false, hostId, paneId: pane.paneId, sessionName: pane.sessionName, reason: 'host_removed', eventId: hostId + ':' + pane.paneId + ':removed:' + this.now() })
      }
      this.hosts.delete(hostId)
    }
  }

  private async pollHost(hostId: string) {
    const state = this.hosts.get(hostId)
    if (!state || state.scanning) return
    state.scanning = true
    try {
      const agents = await this.scan(hostId)
      if (!this.running || this.hosts.get(hostId) !== state) return
      this.applyScan(hostId, state, agents)
    } catch {
      if (!this.running || this.hosts.get(hostId) !== state) return
      this.applyFailure(hostId, state)
    } finally {
      state.scanning = false
    }
  }

  private applyScan(hostId: string, state: MonitorHostState, agents: AgentPaneState[]) {
    const initial = !state.initialized
    const wasDisconnected = state.disconnected
    state.initialized = true
    state.disconnected = false
    const next = new Map<string, AgentPaneState>()
    for (const rawPane of agents) {
      const previous = state.agents.get(rawPane.paneId)
      const pane = wasDisconnected && previous?.phase === 'disconnected' ? { ...rawPane, lastEvent: 'reconnected' as const, updatedAt: new Date(this.now()).toISOString(), eventId: hostId + ':' + rawPane.paneId + ':reconnected:' + this.now() } : rawPane
      next.set(pane.paneId, pane)
    }
    const previousAgents = state.agents
    for (const pane of next.values()) {
      if (pane.eventId) continue
      next.set(pane.paneId, { ...pane, eventId: this.eventId(hostId, pane, pane.lastEvent || 'changed', state.revision + 1) })
    }
    state.agents = next
    if (initial) {
      state.revision += 1
      this.emit({ type: 'agent_status_snapshot', initial: true, hostId, revision: state.revision, agents: sortAgents(next.values()), eventId: hostId + ':snapshot:' + state.revision })
      return
    }
    for (const pane of next.values()) {
      const previous = previousAgents.get(pane.paneId)
      if (samePane(previous, pane)) continue
      state.revision += 1
      const eventId = pane.eventId || this.eventId(hostId, pane, pane.lastEvent || 'changed', state.revision)
      const changed: AgentMonitorEvent = { type: 'agent_status_changed', initial, hostId, sessionName: pane.sessionName, pane: { ...pane, eventId }, eventId }
      this.emit(changed)
      if (!initial && pane.eventId !== previous?.eventId && pane.lastEvent && notificationEvents.has(pane.lastEvent)) this.emit({ type: 'agent_notification', initial: false, hostId, sessionName: pane.sessionName, pane: { ...pane, eventId }, eventId })
    }
    for (const previous of previousAgents.values()) {
      if (next.has(previous.paneId)) continue
      forgetAgentPane(previous.paneId)
      state.revision += 1
      const eventId = hostId + ':' + previous.paneId + ':' + (previous.agentSessionId || previous.sessionName) + ':removed:' + state.revision
      this.emit({ type: 'agent_status_removed', initial, hostId, paneId: previous.paneId, sessionName: previous.sessionName, reason: 'pane_exited', eventId })
      if (!initial && previous.lastEvent !== 'ended') {
        const pane: AgentPaneState = { ...previous, agentStatus: 'unknown', phase: 'ended', lastEvent: 'ended', source: 'tmux', confidence: 'medium', updatedAt: new Date(this.now()).toISOString(), eventId, message: 'Agent session ended' }
        this.emit({ type: 'agent_notification', initial: false, hostId, sessionName: previous.sessionName, pane, eventId })
      }
    }
  }

  private applyFailure(hostId: string, state: MonitorHostState) {
    const initial = !state.initialized
    if (!state.disconnected) {
      state.disconnected = true
      for (const previous of state.agents.values()) {
        state.revision += 1
        const pane: AgentPaneState = { ...previous, agentStatus: 'unknown', phase: 'disconnected', lastEvent: 'disconnected', source: 'tmux', confidence: 'medium', updatedAt: new Date(this.now()).toISOString(), eventId: hostId + ':' + previous.paneId + ':disconnected:' + state.revision, message: 'Agent host is unavailable' }
        state.agents.set(pane.paneId, pane)
        this.emit({ type: 'agent_status_changed', initial, hostId, sessionName: pane.sessionName, pane, eventId: pane.eventId! })
        if (!initial) this.emit({ type: 'agent_notification', initial: false, hostId, sessionName: pane.sessionName, pane, eventId: pane.eventId! })
      }
    }
    this.emit({ type: 'agent_monitor_error', initial: false, hostId, message: 'Agent monitor scan failed', retrying: true })
  }

  private emitSnapshot(listener: (event: AgentMonitorEvent) => void, hostId: string, state: MonitorHostState) {
    listener({ type: 'agent_status_snapshot', initial: true, hostId, revision: state.revision, agents: sortAgents(state.agents.values()), eventId: hostId + ':snapshot:' + state.revision })
  }

  private emit(event: AgentMonitorEvent) {
    for (const listener of this.listeners) listener(event)
  }

  private eventId(hostId: string, pane: AgentPaneState, event: AgentEvent | 'changed' | 'seen', revision: number) {
    return hostId + ':' + pane.paneId + ':' + event + ':' + revision
  }
}

export const agentMonitor = new AgentMonitor()
