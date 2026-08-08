import { randomUUID } from 'crypto'
import { agentMonitor, type AgentMonitorEvent } from './agent-monitor.js'
import { getHostAgentPanes, type AgentPaneState } from './agent-state.js'
import { execTmux } from './tmux-executor.js'

export type AgentWaitTarget =
  | { paneId: string }
  | { sessionName: string; agent: string }
export interface AgentWaitCondition {
  status?: AgentPaneState['agentStatus']
  phase?: AgentPaneState['phase']
  lastEvent?: AgentPaneState['lastEvent']
}
export interface AgentWaitOptions {
  hostId?: string
  timeoutMs?: number
  now?: () => number
  getStates?: (hostId: string) => AgentPaneState[] | null
  subscribe?: (listener: (event: AgentMonitorEvent) => void) => () => void
  scanStates?: (hostId: string) => Promise<AgentPaneState[]>
}
export interface AgentWaitResult {
  pane: AgentPaneState
  elapsedMs: number
  waitId: string
}
export class AgentWaitError extends Error {
  readonly code: 'OCCUPANT_CHANGED' | 'PANE_REMOVED' | 'TIMEOUT' | 'INVALID_TARGET'
  constructor(code: AgentWaitError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'AgentWaitError'
  }
}
interface PinnedOccupant {
  agent?: string
  agentSessionId?: string
  paneId?: string
}
interface PendingWait {
  waitId: string
  hostId: string
  target: AgentWaitTarget
  condition: AgentWaitCondition
  pinned: PinnedOccupant | null
  startedAt: number
  resolve: (value: AgentWaitResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
function parsePaneId(paneId: string) {
  const separator = paneId.indexOf(':')
  if (separator <= 0 || separator === paneId.length - 1 || !paneId.slice(separator + 1).startsWith('%')) throw new AgentWaitError('INVALID_TARGET', 'Invalid pane id')
  return { hostId: paneId.slice(0, separator), tmuxPaneId: paneId.slice(separator + 1) }
}
export function resolveAgentWaitTarget(target: AgentWaitTarget, defaultHostId = 'local') {
  if ('paneId' in target) {
    const { hostId, tmuxPaneId } = parsePaneId(target.paneId)
    return { hostId, tmuxPaneId }
  }
  if (!target.sessionName || !target.agent) throw new AgentWaitError('INVALID_TARGET', 'Wait target requires sessionName and agent')
  return { hostId: defaultHostId, tmuxPaneId: '' }
}
function matchesTarget(pane: AgentPaneState, target: AgentWaitTarget) {
  if ('paneId' in target) return pane.paneId === target.paneId
  return pane.sessionName === target.sessionName && pane.agent === target.agent
}
function matchesSession(pane: AgentPaneState, target: AgentWaitTarget) {
  if ('paneId' in target) return pane.paneId === target.paneId
  return pane.sessionName === target.sessionName
}
function matchesCondition(pane: AgentPaneState, condition: AgentWaitCondition) {
  if (condition.status && pane.agentStatus !== condition.status) return false
  if (condition.phase && pane.phase !== condition.phase) return false
  if (condition.lastEvent && pane.lastEvent !== condition.lastEvent) return false
  return true
}
function hasCondition(condition: AgentWaitCondition) {
  return !!(condition.status || condition.phase || condition.lastEvent)
}
function findMatchingPane(states: AgentPaneState[] | null, target: AgentWaitTarget) {
  return states?.find((pane) => matchesTarget(pane, target)) || null
}
export class AgentControl {
  private readonly now: () => number
  private readonly getStates: (hostId: string) => AgentPaneState[] | null
  private readonly subscribe: (listener: (event: AgentMonitorEvent) => void) => () => void
  private readonly scanStates: (hostId: string) => Promise<AgentPaneState[]>
  private readonly waits = new Map<string, PendingWait>()
  private unsubscribe: (() => void) | null = null
  constructor(options: AgentWaitOptions = {}) {
    this.now = options.now || (() => Date.now())
    this.getStates = options.getStates || ((hostId) => agentMonitor.getStates(hostId))
    this.subscribe = options.subscribe || ((listener) => agentMonitor.subscribe(listener))
    this.scanStates = options.scanStates || ((hostId) => getHostAgentPanes(hostId))
  }
  private ensureSubscribed() {
    if (this.unsubscribe) return
    this.unsubscribe = this.subscribe((event) => this.handleEvent(event))
  }
  private ensureUnsubscribed() {
    if (!this.waits.size && this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }
  async wait(target: AgentWaitTarget, condition: AgentWaitCondition, options: AgentWaitOptions = {}): Promise<AgentWaitResult> {
    if (!hasCondition(condition)) throw new AgentWaitError('INVALID_TARGET', 'Wait condition requires status, phase, or lastEvent')
    const { hostId } = resolveAgentWaitTarget(target, options.hostId || 'local')
    if (!hostId) throw new AgentWaitError('INVALID_TARGET', 'Wait target is invalid')
    const startedAt = this.now()
    const timeoutMs = Math.max(250, Math.min(options.timeoutMs || 60000, 600000))
    const waitId = randomUUID()
    const states = this.getStates(hostId) || await this.scanStates(hostId).catch(() => [])
    const initial = findMatchingPane(states, target)
    if (initial && matchesCondition(initial, condition)) return { pane: initial, elapsedMs: 0, waitId }
    const pinned: PinnedOccupant | null = initial ? { agent: initial.agent, agentSessionId: initial.agentSessionId, paneId: initial.paneId } : null
    return new Promise<AgentWaitResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.waits.get(waitId)
        if (!pending) return
        this.waits.delete(waitId)
        this.ensureUnsubscribed()
        reject(new AgentWaitError('TIMEOUT', `Agent wait timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waits.set(waitId, { waitId, hostId, target, condition, pinned, startedAt, resolve, reject, timer })
      this.ensureSubscribed()
    })
  }
  private handleEvent(event: AgentMonitorEvent) {
    if (event.type === 'agent_status_changed' || event.type === 'agent_status_snapshot') {
      for (const pane of event.type === 'agent_status_snapshot' ? event.agents : [event.pane]) this.evaluatePane(event.hostId, pane)
    }
    if (event.type === 'agent_status_removed') {
      for (const pending of [...this.waits.values()]) {
        if (pending.hostId !== event.hostId) continue
        if ('paneId' in pending.target && pending.target.paneId === event.paneId) this.failWait(pending, new AgentWaitError('PANE_REMOVED', `Target pane ${event.paneId} was removed`))
        else if (!('paneId' in pending.target) && pending.pinned?.paneId === event.paneId) this.failWait(pending, new AgentWaitError('PANE_REMOVED', `Target pane ${event.paneId} was removed`))
      }
    }
  }
  private evaluatePane(hostId: string, pane: AgentPaneState) {
    for (const pending of [...this.waits.values()]) {
      if (pending.hostId !== hostId || !matchesSession(pane, pending.target)) continue
      if (!pending.pinned) {
        if ('paneId' in pending.target) pending.pinned = { agent: pane.agent, agentSessionId: pane.agentSessionId, paneId: pane.paneId }
        else if (pane.agent === pending.target.agent) pending.pinned = { agent: pane.agent, agentSessionId: pane.agentSessionId, paneId: pane.paneId }
        else {
          this.failWait(pending, new AgentWaitError('OCCUPANT_CHANGED', `Session ${pane.sessionName} is occupied by ${pane.agent} instead of ${pending.target.agent}`))
          continue
        }
      }
      if (pending.pinned.paneId && pending.pinned.paneId !== pane.paneId) continue
      const occupantChanged = pending.pinned.agent !== undefined && pane.agent !== pending.pinned.agent || pending.pinned.agentSessionId !== undefined && pane.agentSessionId !== pending.pinned.agentSessionId
      if (occupantChanged) {
        this.failWait(pending, new AgentWaitError('OCCUPANT_CHANGED', `Pane occupant changed from ${pending.pinned.agent || 'unknown'} to ${pane.agent || 'unknown'} before wait condition was met`))
        continue
      }
      if (!matchesCondition(pane, pending.condition)) continue
      const elapsedMs = this.now() - pending.startedAt
      this.waits.delete(pending.waitId)
      clearTimeout(pending.timer)
      this.ensureUnsubscribed()
      pending.resolve({ pane, elapsedMs, waitId: pending.waitId })
    }
  }
  private failWait(pending: PendingWait, error: Error) {
    if (this.waits.get(pending.waitId) !== pending) return
    this.waits.delete(pending.waitId)
    clearTimeout(pending.timer)
    this.ensureUnsubscribed()
    pending.reject(error)
  }
  activeWaitCount() {
    return this.waits.size
  }
}
export const agentControl = new AgentControl()
export async function splitAgentPane(hostId: string, tmuxPaneId: string, direction: 'horizontal' | 'vertical', cwd?: string) {
  const args = ['split-window']
  if (cwd && cwd.trim() && /^[A-Za-z0-9_./~-]+$/.test(cwd.trim())) args.push('-c', cwd.trim())
  args.push('-e', 'TMUXGO_ENV=1', '-t', tmuxPaneId, direction === 'horizontal' ? '-h' : '-v')
  await execTmux(hostId, args)
  const { stdout } = await execTmux(hostId, ['list-panes', '-s', '-t', tmuxPaneId, '-F', '#{pane_id}'])
  const panes = stdout.trim().split('\n').filter(Boolean)
  return panes[panes.length - 1] || ''
}
export async function readAgentPane(hostId: string, tmuxPaneId: string, lines = 200) {
  const count = Math.max(1, Math.min(Math.floor(lines), 2000))
  const { stdout } = await execTmux(hostId, ['capture-pane', '-e', '-p', '-t', tmuxPaneId, '-S', `-${count}`])
  return stdout
}
