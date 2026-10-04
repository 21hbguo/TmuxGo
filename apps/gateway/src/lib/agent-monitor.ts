import { agentManager } from '../agent-manager.js'
import { listAllHosts } from './hosts.js'
import {
  forgetAgentPane,
  getHostAgentPanes,
  markAgentPaneSeen,
  type AgentEvent,
  type AgentPaneState,
} from './agent-state.js'
import { persistAgentNotification } from './agent-notifications.js'
import { upsertRecoveryCandidate, type RecoveryCandidateInput } from './agent-recovery.js'
import type { AgentProtocolEvent } from './agent-events.js'

export type AgentMonitorEvent =
  | {
      type: 'agent_status_snapshot'
      initial: true
      hostId: string
      revision: number
      agents: AgentPaneState[]
      eventId: string
    }
  | {
      type: 'agent_status_changed'
      initial: boolean
      hostId: string
      sessionName: string
      pane: AgentPaneState
      eventId: string
    }
  | {
      type: 'agent_status_removed'
      initial: boolean
      hostId: string
      paneId: string
      sessionName: string
      reason: string
      eventId: string
    }
  | {
      type: 'agent_notification'
      initial: false
      hostId: string
      sessionName: string
      pane: AgentPaneState
      eventId: string
    }
  | { type: 'agent_monitor_error'; initial: false; hostId: string; message: string; retrying: true }

interface MonitorHostState {
  agents: Map<string, AgentPaneState>
  protocolEvents: Map<string, AgentProtocolEvent>
  protocolEventIds: Set<string>
  // paneId -> (display.source || '') -> 已应用的最大 seq：分来源去乱序
  displaySeqs: Map<string, Map<string, number>>
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
  idleMs?: number
  hostRefreshMs?: number
  now?: () => number
  onNotification?: (event: Extract<AgentMonitorEvent, { type: 'agent_notification' }>) => void
  // recovery manifest 落点：pane 移除/host 下线/agent 进程结束时记录候选；
  // 只记录绝不执行 resume——恢复必须走显式 resume API
  onRecoveryCandidate?: (candidate: RecoveryCandidateInput) => void
}

const notificationEvents = new Set<AgentEvent>([
  'permission_required',
  'question_required',
  'completed',
  'failed',
  'ended',
  'disconnected',
])
const protocolOverlayMaxAgeMs = 30 * 60 * 1000
const displayDefaultTtlMs = 60 * 1000
const notificationThrottleMs = 30 * 1000
// monitor 物化的 pane 状态全局序号：只在状态内容真实变化时递增，
// agent.wait 用 wait 建立时刻的最大值做基线，忽略其前已存在的旧状态回放
let nextStateSeq = 0

function sortAgents(agents: Iterable<AgentPaneState>) {
  return [...agents].sort((left, right) => left.paneId.localeCompare(right.paneId))
}
function sameDisplay(left: AgentPaneState['display'], right: AgentPaneState['display']) {
  if (!left && !right) return true
  if (!left || !right) return false
  return (
    left.title === right.title &&
    left.stateLabel === right.stateLabel &&
    left.tokens === right.tokens &&
    left.seq === right.seq &&
    left.source === right.source &&
    left.updatedAt === right.updatedAt
  )
}
function samePane(left: AgentPaneState | undefined, right: AgentPaneState) {
  if (!left) return false
  return (
    left.paneId === right.paneId &&
    left.tmuxPaneId === right.tmuxPaneId &&
    left.sessionName === right.sessionName &&
    left.agent === right.agent &&
    left.agentSessionId === right.agentSessionId &&
    left.nativeAgentSessionId === right.nativeAgentSessionId &&
    left.agentStatus === right.agentStatus &&
    left.phase === right.phase &&
    left.lastEvent === right.lastEvent &&
    left.source === right.source &&
    left.confidence === right.confidence &&
    left.since === right.since &&
    left.updatedAt === right.updatedAt &&
    left.eventId === right.eventId &&
    left.message === right.message &&
    left.revision === right.revision &&
    sameDisplay(left.display, right.display)
  )
}
function matchesProtocolEvent(event: AgentProtocolEvent, pane: AgentPaneState) {
  if (event.paneId && event.paneId === pane.paneId) return true
  if (event.tmuxPaneId && event.tmuxPaneId === pane.tmuxPaneId) return true
  if (event.agentSessionId && event.agentSessionId === pane.agentSessionId) return true
  return !!event.sessionName && event.sessionName === pane.sessionName && event.agent === pane.agent
}
function protocolEventKey(event: AgentProtocolEvent) {
  return event.paneId || event.tmuxPaneId || event.agentSessionId || `${event.sessionName || ''}:${event.agent}`
}
function protocolEventIsRecent(event: AgentProtocolEvent, now: number) {
  const timestamp = Date.parse(event.timestamp)
  return Number.isFinite(timestamp) && now - timestamp <= protocolOverlayMaxAgeMs
}
function protocolAgentStatus(event: AgentProtocolEvent): AgentPaneState['agentStatus'] {
  if (event.lastEvent === 'completed') return 'done'
  if (event.phase === 'permission_required' || event.phase === 'needs_input') return 'blocked'
  if (event.phase === 'working' || event.phase === 'retrying') return 'working'
  if (event.phase === 'idle') return 'idle'
  return 'unknown'
}
function resolveDisplay(display: AgentPaneState['display'], now: number): AgentPaneState['display'] {
  if (!display) return undefined
  if (!display.ttlMs || !display.updatedAt) return display
  const updatedAt = Date.parse(display.updatedAt)
  if (!Number.isFinite(updatedAt) || now - updatedAt > display.ttlMs) return undefined
  return display
}
function applyDisplayPatch(
  current: AgentPaneState['display'],
  patch: AgentProtocolEvent['display'],
  displaySeqs: Map<string, number> | undefined,
  now: number,
): AgentPaneState['display'] | undefined {
  if (!patch) return current
  // seq 按 patch.source 分桶（'' = 未带 source 的旧客户端）；桶内无记录时回退到
  // 「当前 display 由同桶写入」的 seq，纯旧客户端链路行为与分桶前完全一致
  const scope = patch.source || ''
  const lastSeq = displaySeqs?.get(scope) ?? ((current?.source || '') === scope ? current?.seq : undefined)
  if (patch.seq === undefined) {
    if (lastSeq !== undefined) return current
  } else if (lastSeq !== undefined && patch.seq <= lastSeq) return current
  if (patch.seq !== undefined) displaySeqs?.set(scope, patch.seq)
  return {
    title: patch.title ?? current?.title,
    stateLabel: patch.stateLabel ?? current?.stateLabel,
    tokens: patch.tokens ?? current?.tokens,
    seq: patch.seq ?? current?.seq,
    // seq 与 source 必须同源归属：patch 写入 seq 时 source 记为 patch 的来源桶
    // （未带 source 即清空），未写 seq 时沿用当前 seq 的归属
    source: patch.seq !== undefined ? patch.source : current?.source,
    ttlMs: patch.ttlMs ?? current?.ttlMs ?? displayDefaultTtlMs,
    updatedAt: new Date(now).toISOString(),
  }
}
function applyProtocolEvent(
  pane: AgentPaneState,
  event: AgentProtocolEvent,
  now: number,
  displaySeqs?: Map<string, number>,
) {
  return {
    ...pane,
    agent: event.agent || pane.agent,
    agentSessionId: event.agentSessionId || pane.agentSessionId,
    nativeAgentSessionId: event.agentSessionId || pane.nativeAgentSessionId,
    agentStatus: protocolAgentStatus(event),
    phase: event.phase,
    lastEvent: event.lastEvent,
    source: event.source,
    confidence: event.confidence,
    since: event.timestamp,
    updatedAt: event.timestamp,
    eventId: event.eventId,
    message: event.message,
    display: resolveDisplay(applyDisplayPatch(pane.display, event.display, displaySeqs, now), now),
  }
}

export class AgentMonitor {
  private readonly scan: (hostId: string) => Promise<AgentPaneState[]>
  private readonly getHostIds: () => Promise<string[]>
  private readonly intervalMs: number
  private readonly idleMs: number
  private readonly hostRefreshMs: number
  private readonly now: () => number
  private readonly onNotification?: (event: Extract<AgentMonitorEvent, { type: 'agent_notification' }>) => void
  private readonly onRecoveryCandidate: (candidate: RecoveryCandidateInput) => void
  private readonly hosts = new Map<string, MonitorHostState>()
  private readonly pendingProtocolEvents = new Map<string, Map<string, AgentProtocolEvent>>()
  private readonly listeners = new Set<(event: AgentMonitorEvent) => void>()
  private readonly notificationThrottle = new Map<string, number>()
  private hostRefreshTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private startPromise: Promise<void> | null = null

  constructor(options: AgentMonitorOptions = {}) {
    this.scan = options.scan || ((hostId) => getHostAgentPanes(hostId))
    this.getHostIds =
      options.getHostIds ||
      (async () => {
        const hosts = await listAllHosts()
        const ids = new Set(hosts.map((host) => host.id))
        for (const agent of agentManager.getAllAgentStatuses()) ids.add(agent.id)
        return [...ids]
      })
    this.intervalMs = Math.max(250, options.intervalMs || 1500)
    this.idleMs = Math.max(this.intervalMs, options.idleMs || 30000)
    this.hostRefreshMs = Math.max(this.intervalMs, options.hostRefreshMs || 5000)
    this.now = options.now || (() => Date.now())
    this.onNotification = options.onNotification
    this.onRecoveryCandidate =
      options.onRecoveryCandidate || ((candidate) => void upsertRecoveryCandidate(candidate).catch(() => {}))
  }
  private recordRecoveryCandidate(hostId: string, pane: AgentPaneState, reason: string) {
    try {
      this.onRecoveryCandidate({
        hostId,
        sessionName: pane.sessionName,
        paneId: pane.paneId,
        tmuxPaneId: pane.tmuxPaneId,
        agent: pane.agent,
        agentSessionId: pane.nativeAgentSessionId,
        cwd: pane.cwd,
        lastSeenAt: pane.updatedAt || new Date(this.now()).toISOString(),
        reason,
      })
    } catch {}
  }

  async start() {
    if (this.running) return this.startPromise || Promise.resolve()
    this.running = true
    this.startPromise = (async () => {
      await this.refreshHosts(false)
      await Promise.all([...this.hosts.keys()].map((hostId) => this.pollHost(hostId)))
      if (this.running) this.hostRefreshTimer = setInterval(() => void this.refreshHosts(), this.hostRefreshMs)
    })()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
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
    for (const pane of [...this.hosts.values()].flatMap((state) => [...state.agents.values()]))
      forgetAgentPane(pane.paneId)
    this.pendingProtocolEvents.clear()
    this.notificationThrottle.clear()
    this.hosts.clear()
  }

  subscribe(listener: (event: AgentMonitorEvent) => void) {
    const wasIdle = !this.listeners.size
    this.listeners.add(listener)
    for (const [hostId, state] of this.hosts) if (state.initialized) this.emitSnapshot(listener, hostId, state)
    if (!this.running) void this.start()
    else if (wasIdle) this.refreshPollCadence()
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.refreshPollCadence()
    }
  }

  // 有订阅者用快速档（intervalMs），零订阅降怠速档（idleMs）：
  // onNotification/web-push 不依赖 listeners，慢档仍保住后台通知，同时空闲时远程轮询降 ~20×
  private currentPollMs() {
    return this.listeners.size ? this.intervalMs : this.idleMs
  }
  private refreshPollCadence() {
    if (!this.running) return
    const ms = this.currentPollMs()
    for (const [hostId, state] of this.hosts) {
      if (state.timer) clearInterval(state.timer)
      state.timer = setInterval(() => void this.pollHost(hostId), ms)
    }
    if (this.listeners.size) for (const hostId of this.hosts.keys()) void this.pollHost(hostId)
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

  ingestProtocolEvent(event: AgentProtocolEvent) {
    if (!event.hostId || !event.eventId) return null
    const state = this.hosts.get(event.hostId)
    if (!state) {
      const pending = this.pendingProtocolEvents.get(event.hostId) || new Map<string, AgentProtocolEvent>()
      const key = protocolEventKey(event)
      const previous = pending.get(key)
      if (previous && Date.parse(previous.timestamp) >= Date.parse(event.timestamp)) return null
      pending.set(key, event)
      this.pendingProtocolEvents.set(event.hostId, pending)
      return null
    }
    if (state.protocolEventIds.has(event.eventId)) return null
    state.protocolEventIds.add(event.eventId)
    const key = protocolEventKey(event)
    const previous = state.protocolEvents.get(key)
    if (previous && Date.parse(previous.timestamp) >= Date.parse(event.timestamp)) return null
    state.protocolEvents.set(key, event)
    if (!state.initialized) return null
    return this.applyProtocolEventToState(event.hostId, state, event)
  }

  markSeen(paneId: string) {
    for (const [hostId, state] of this.hosts) {
      const current = state.agents.get(paneId)
      if (!current) continue
      const marked = markAgentPaneSeen(paneId)
      if (!marked || samePane(current, marked)) return null
      const pane = { ...marked, stateSeq: ++nextStateSeq }
      state.agents.set(paneId, pane)
      state.revision += 1
      const event: AgentMonitorEvent = {
        type: 'agent_status_changed',
        initial: false,
        hostId,
        sessionName: pane.sessionName,
        pane,
        eventId: this.eventId(hostId, pane, 'seen', state.revision),
      }
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
      const protocolEvents = this.pendingProtocolEvents.get(hostId) || new Map()
      const state: MonitorHostState = {
        agents: new Map(),
        protocolEvents,
        protocolEventIds: new Set([...protocolEvents.values()].map((event) => event.eventId)),
        displaySeqs: new Map(),
        revision: 0,
        initialized: false,
        disconnected: false,
        scanning: false,
        timer: null,
      }
      this.pendingProtocolEvents.delete(hostId)
      this.hosts.set(hostId, state)
      if (this.running) {
        state.timer = setInterval(() => void this.pollHost(hostId), this.currentPollMs())
        if (pollNewHosts) void this.pollHost(hostId)
      }
    }
    for (const [hostId, state] of this.hosts) {
      if (nextIds.has(hostId)) continue
      if (state.timer) clearInterval(state.timer)
      for (const pane of state.agents.values()) {
        forgetAgentPane(pane.paneId)
        this.recordRecoveryCandidate(hostId, pane, 'host_removed')
        this.emit({
          type: 'agent_status_removed',
          initial: false,
          hostId,
          paneId: pane.paneId,
          sessionName: pane.sessionName,
          reason: 'host_removed',
          eventId: hostId + ':' + pane.paneId + ':removed:' + this.now(),
        })
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
    for (const [key, event] of state.protocolEvents)
      if (!protocolEventIsRecent(event, this.now())) state.protocolEvents.delete(key)
    for (const rawPane of agents) {
      const previous = state.agents.get(rawPane.paneId)
      const basePane = previous?.display
        ? { ...rawPane, display: resolveDisplay(previous.display, this.now()) }
        : rawPane
      const reconnected =
        wasDisconnected && previous?.phase === 'disconnected'
          ? {
              ...basePane,
              lastEvent: 'reconnected' as const,
              updatedAt: new Date(this.now()).toISOString(),
              eventId: hostId + ':' + rawPane.paneId + ':reconnected:' + this.now(),
            }
          : basePane
      const matchingProtocolEvents = [...state.protocolEvents.values()]
        .filter((event) => matchesProtocolEvent(event, reconnected))
        .filter(
          (event) =>
            event.paneId ||
            event.tmuxPaneId ||
            event.agentSessionId ||
            agents.filter((candidate) => candidate.sessionName === event.sessionName && candidate.agent === event.agent)
              .length === 1,
        )
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      const pane = matchingProtocolEvents.reduce(
        (current, event) => applyProtocolEvent(current, { ...event, display: undefined }, this.now()),
        reconnected,
      )
      next.set(pane.paneId, resolveDisplay(pane, this.now()) ? pane : { ...pane, display: undefined })
    }
    const previousAgents = state.agents
    // stateSeq 戳记与 eventId 回填同一轮完成：内容未变的 pane 沿用旧 seq，
    // agent.wait 基线据此区分「真实新变化」与「wait 建立前的旧状态回放」
    for (const pane of next.values()) {
      const prior = previousAgents.get(pane.paneId)
      const eventId = pane.eventId || this.eventId(hostId, pane, pane.lastEvent || 'changed', state.revision + 1)
      const candidate = { ...pane, eventId }
      const stateSeq = prior?.stateSeq !== undefined && samePane(prior, candidate) ? prior.stateSeq : ++nextStateSeq
      next.set(pane.paneId, { ...candidate, stateSeq })
    }
    state.agents = next
    if (initial) {
      state.revision += 1
      this.emit({
        type: 'agent_status_snapshot',
        initial: true,
        hostId,
        revision: state.revision,
        agents: sortAgents(next.values()),
        eventId: hostId + ':snapshot:' + state.revision,
      })
      return
    }
    for (const pane of next.values()) {
      const previous = previousAgents.get(pane.paneId)
      if (samePane(previous, pane)) continue
      state.revision += 1
      const eventId = pane.eventId || this.eventId(hostId, pane, pane.lastEvent || 'changed', state.revision)
      const changed: AgentMonitorEvent = {
        type: 'agent_status_changed',
        initial,
        hostId,
        sessionName: pane.sessionName,
        pane: { ...pane, eventId },
        eventId,
      }
      this.emit(changed)
      // agent 进程在 pane 内退出但 pane 仍存活（协议 session_ended / paneDead）：
      // 与 pane 移除并列记 recovery 候选，恢复目标仍是这个空闲 pane
      if (!initial && pane.phase === 'ended' && previous?.phase !== 'ended')
        this.recordRecoveryCandidate(hostId, pane, 'process_exited')
      if (!initial && pane.eventId !== previous?.eventId && pane.lastEvent && notificationEvents.has(pane.lastEvent))
        this.emit({
          type: 'agent_notification',
          initial: false,
          hostId,
          sessionName: pane.sessionName,
          pane: { ...pane, eventId },
          eventId,
        })
    }
    for (const previous of previousAgents.values()) {
      if (next.has(previous.paneId)) continue
      this.clearNotificationThrottle(previous.paneId)
      state.displaySeqs.delete(previous.paneId)
      forgetAgentPane(previous.paneId)
      this.recordRecoveryCandidate(hostId, previous, 'pane_exited')
      state.revision += 1
      const eventId =
        hostId +
        ':' +
        previous.paneId +
        ':' +
        (previous.agentSessionId || previous.sessionName) +
        ':removed:' +
        state.revision
      this.emit({
        type: 'agent_status_removed',
        initial,
        hostId,
        paneId: previous.paneId,
        sessionName: previous.sessionName,
        reason: 'pane_exited',
        eventId,
      })
      if (!initial && previous.lastEvent !== 'ended') {
        const pane: AgentPaneState = {
          ...previous,
          agentStatus: 'unknown',
          phase: 'ended',
          lastEvent: 'ended',
          source: 'tmux',
          confidence: 'medium',
          updatedAt: new Date(this.now()).toISOString(),
          eventId,
          message: 'Agent session ended',
        }
        this.emit({
          type: 'agent_notification',
          initial: false,
          hostId,
          sessionName: previous.sessionName,
          pane,
          eventId,
        })
      }
    }
  }

  private applyFailure(hostId: string, state: MonitorHostState) {
    const initial = !state.initialized
    if (!state.disconnected) {
      state.disconnected = true
      for (const previous of state.agents.values()) {
        state.revision += 1
        const pane: AgentPaneState = {
          ...previous,
          agentStatus: 'unknown',
          phase: 'disconnected',
          lastEvent: 'disconnected',
          source: 'tmux',
          confidence: 'medium',
          updatedAt: new Date(this.now()).toISOString(),
          eventId: hostId + ':' + previous.paneId + ':disconnected:' + state.revision,
          stateSeq: ++nextStateSeq,
          message: 'Agent host is unavailable',
        }
        state.agents.set(pane.paneId, pane)
        this.emit({
          type: 'agent_status_changed',
          initial,
          hostId,
          sessionName: pane.sessionName,
          pane,
          eventId: pane.eventId!,
        })
        if (!initial)
          this.emit({
            type: 'agent_notification',
            initial: false,
            hostId,
            sessionName: pane.sessionName,
            pane,
            eventId: pane.eventId!,
          })
      }
    }
    this.emit({
      type: 'agent_monitor_error',
      initial: false,
      hostId,
      message: 'Agent monitor scan failed',
      retrying: true,
    })
  }

  private applyProtocolEventToState(hostId: string, state: MonitorHostState, event: AgentProtocolEvent) {
    const panes = [...state.agents.values()].filter((pane) => matchesProtocolEvent(event, pane))
    const current =
      panes.find((pane) => event.paneId === pane.paneId) ||
      panes.find((pane) => event.tmuxPaneId === pane.tmuxPaneId) ||
      panes.find((pane) => event.agentSessionId === pane.agentSessionId) ||
      (panes.length === 1 ? panes[0] : undefined)
    const paneId = current?.paneId || event.paneId || (event.tmuxPaneId ? `${hostId}:${event.tmuxPaneId}` : '')
    if (!paneId || (!current && !event.sessionName)) return null
    const base = current || {
      paneId,
      tmuxPaneId: event.tmuxPaneId || paneId.slice(paneId.indexOf(':') + 1),
      sessionName: event.sessionName!,
      agent: event.agent,
      agentSessionId: event.agentSessionId || paneId,
      agentStatus: 'unknown' as const,
      revision: 0,
    }
    let displaySeqs = state.displaySeqs.get(paneId)
    if (event.display && !displaySeqs) state.displaySeqs.set(paneId, (displaySeqs = new Map()))
    const pane = {
      ...applyProtocolEvent(base, event, this.now(), displaySeqs),
      revision: ++state.revision,
      stateSeq: ++nextStateSeq,
    }
    state.agents.set(pane.paneId, pane)
    const changed: AgentMonitorEvent = {
      type: 'agent_status_changed',
      initial: false,
      hostId,
      sessionName: pane.sessionName,
      pane,
      eventId: event.eventId,
    }
    this.emit(changed)
    if (pane.phase === 'ended') this.recordRecoveryCandidate(hostId, pane, 'process_exited')
    if (pane.lastEvent && notificationEvents.has(pane.lastEvent))
      this.emit({
        type: 'agent_notification',
        initial: false,
        hostId,
        sessionName: pane.sessionName,
        pane,
        eventId: event.eventId,
      })
    return pane
  }

  private emitSnapshot(listener: (event: AgentMonitorEvent) => void, hostId: string, state: MonitorHostState) {
    listener({
      type: 'agent_status_snapshot',
      initial: true,
      hostId,
      revision: state.revision,
      agents: sortAgents(state.agents.values()),
      eventId: hostId + ':snapshot:' + state.revision,
    })
  }

  private emit(event: AgentMonitorEvent) {
    if (event.type === 'agent_notification' && !this.passesNotificationThrottle(event.pane, this.now())) return
    for (const listener of this.listeners) listener(event)
    if (event.type === 'agent_notification') this.onNotification?.(event)
  }

  private passesNotificationThrottle(pane: AgentPaneState, now: number) {
    const key = pane.paneId + ':' + (pane.lastEvent || 'state')
    const until = this.notificationThrottle.get(key)
    if (until !== undefined && until > now) return false
    this.notificationThrottle.set(key, now + notificationThrottleMs)
    return true
  }

  private clearNotificationThrottle(paneId: string) {
    for (const key of [...this.notificationThrottle.keys()])
      if (key.startsWith(paneId + ':')) this.notificationThrottle.delete(key)
  }

  private eventId(hostId: string, pane: AgentPaneState, event: AgentEvent | 'changed' | 'seen', revision: number) {
    return hostId + ':' + pane.paneId + ':' + event + ':' + revision
  }
}

export const agentMonitor = new AgentMonitor({ onNotification: (event) => void persistAgentNotification(event) })
