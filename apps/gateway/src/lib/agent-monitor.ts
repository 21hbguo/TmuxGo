import { agentManager } from '../agent-manager.js'
import { listAllHosts } from './hosts.js'
import {
  forgetAgentPane,
  getHostAgentPanes,
  markAgentPaneSeen,
  resolveAgentStatus,
  type AgentEvent,
  type AgentPaneState,
} from './agent-state.js'
import {
  closeAgentTodosForPane,
  getPushSubscriberCount,
  onPushSubscriberChange,
  persistAgentNotification,
  refreshPushSubscriberCount,
} from './agent-notifications.js'
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
  // 连续「扫出 0 个 agent pane」的轮数：为空时降压扫描频率，扫到 pane/出错即清零
  emptyScans: number
}
interface AgentMonitorOptions {
  // signal：宿主停摆（stop）时用来掐掉在跑的扫描（远端是 ssh 子进程），
  // 否则文件/进程要等在跑的 ssh 自然超时才退，测试表现为「用例全绿但进程不退出」
  scan?: (hostId: string, signal?: AbortSignal) => Promise<AgentPaneState[]>
  getHostIds?: () => Promise<string[]>
  intervalMs?: number
  idleMs?: number
  // 有 web-push 订阅者但无 WS 监听者时的折中档：通知延迟由轮询节拍决定，
  // 30s 怠速档会让"需要审批"提醒最坏拖半分钟
  pushPollMs?: number
  hostRefreshMs?: number
  // 空扫退避阶梯（测试缝）：默认读 EMPTY_SCAN_BACKOFF_STEPS
  emptyScanBackoff?: (emptyRounds: number) => number
  hasPushSubscribers?: () => boolean
  now?: () => number
  onNotification?: (event: Extract<AgentMonitorEvent, { type: 'agent_notification' }>) => void
  // recovery manifest 落点：pane 移除/host 下线/agent 进程结束时记录候选；
  // 只记录绝不执行 resume——恢复必须走显式 resume API
  onRecoveryCandidate?: (candidate: RecoveryCandidateInput) => void
  // pane 消失（扫描里没了 / host 被移除）时回调：待办队列据此把该 pane 的未完成项转 done。
  // 为什么不用 subscribe()：常驻 listener 会把 monitor 永久拉到快档（见 currentPollMs）
  onPaneRemoved?: (info: { hostId: string; paneId: string; sessionName: string; reason: string }) => void
}

const notificationEvents = new Set<AgentEvent>([
  'permission_required',
  'question_required',
  'completed',
  'failed',
  'ended',
  'disconnected',
])
// 空扫退避阶梯：远端 host 每扫一次就是一条 ssh（本地只是一次 tmux execFile），
// 而「纯 ssh、从没跑过 agent TUI」的主机永远扫出空集——空结果的持续代价不该按满频付。
// 连续空扫达到 emptyRounds 后，该 host 的扫描间隔至少拉到 floorMs；从高到低匹配，
// 扫到任意 pane 或扫描出错都清零（出错不是「空」，不能拿来退避）。
const EMPTY_SCAN_BACKOFF_STEPS: ReadonlyArray<{ emptyRounds: number; floorMs: number }> = [
  { emptyRounds: 8, floorMs: 120_000 },
  { emptyRounds: 5, floorMs: 60_000 },
  { emptyRounds: 2, floorMs: 15_000 },
]
export function emptyScanBackoffMs(emptyRounds: number): number {
  for (const step of EMPTY_SCAN_BACKOFF_STEPS) if (emptyRounds >= step.emptyRounds) return step.floorMs
  return 0
}
const protocolOverlayMaxAgeMs = 30 * 60 * 1000
const displayDefaultTtlMs = 60 * 1000
// 控制面写入任务号后的覆盖窗：任务号不参与 samePane 判定，若一轮扫描在写入前
// 就抓好了屏、写入后才落地，它会把刚 patch 的值盖回旧值。窗口内以写入值为准，
// 窗口外由 tmux 真值接管（外部 set-option 走的正是这条路径）
const taskOverrideTtlMs = 5 * 1000
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
    // 协议 idle 事件同样不降已完成的 done：与 scan 路径同一套 resolveAgentStatus 语义
    agentStatus: resolveAgentStatus(protocolAgentStatus(event), pane.agentStatus),
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
  private readonly scan: (hostId: string, signal?: AbortSignal) => Promise<AgentPaneState[]>
  private readonly getHostIds: () => Promise<string[]>
  private readonly intervalMs: number
  private readonly idleMs: number
  private readonly pushPollMs: number
  private readonly hostRefreshMs: number
  private readonly emptyScanBackoff: (emptyRounds: number) => number
  private readonly now: () => number
  private readonly onNotification?: (event: Extract<AgentMonitorEvent, { type: 'agent_notification' }>) => void
  private readonly onRecoveryCandidate: (candidate: RecoveryCandidateInput) => void
  private readonly onPaneRemoved?: AgentMonitorOptions['onPaneRemoved']
  private readonly hosts = new Map<string, MonitorHostState>()
  // paneId -> 最近一次经控制面/UI 写入的任务号及其时刻（见 taskOverrideTtlMs）
  private readonly taskOverrides = new Map<string, { task: string | undefined; at: number }>()
  private readonly pendingProtocolEvents = new Map<string, Map<string, AgentProtocolEvent>>()
  private readonly listeners = new Set<(event: AgentMonitorEvent) => void>()
  private readonly notificationThrottle = new Map<string, number>()
  private readonly hasPushSubscribers: () => boolean
  private lastPushSubscribers = false
  private unsubscribePushChange: (() => void) | null = null
  private hostRefreshTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  // 每轮 start 的世代号：stop() 会 +1 让「还在飞的 start」失效。没有它，一次
  // stop/start 交错就能让上一轮 start 在 stop 之后挂上 hostRefreshTimer，再被新一轮
  // 覆盖成孤儿定时器——进程于是永远退不掉（测试表现为用例全绿后文件级超时）
  private runGeneration = 0
  // 每轮运行一个 controller：stop() 一 abort，在跑的扫描（远端 ssh 子进程）立刻被掐断。
  // 只影响「还在飞的扫描」，不改变任何对外语义——正常轮询仍按节拍走。
  private scanAbort: AbortController | null = null
  private startPromise: Promise<void> | null = null

  constructor(options: AgentMonitorOptions = {}) {
    this.scan = options.scan || ((hostId, signal) => getHostAgentPanes(hostId, undefined, signal))
    this.getHostIds =
      options.getHostIds ||
      (async () => {
        const hosts = await listAllHosts()
        const ids = new Set(hosts.map((host) => host.id))
        for (const agent of agentManager.getAllAgentStatuses()) ids.add(agent.id)
        return [...ids]
      })
    this.intervalMs = Math.max(250, options.intervalMs || 1500)
    // 怠速档可配：远端 SSH 主机多/链路贵时调大，通知敏感部署可调小
    this.idleMs = Math.max(this.intervalMs, Number(process.env.TMUXGO_AGENT_IDLE_POLL_MS) || options.idleMs || 30000)
    this.pushPollMs = Math.max(this.intervalMs, options.pushPollMs || 5000)
    this.hasPushSubscribers = options.hasPushSubscribers || (() => getPushSubscriberCount() > 0)
    this.hostRefreshMs = Math.max(this.intervalMs, options.hostRefreshMs || 5000)
    this.emptyScanBackoff = options.emptyScanBackoff || emptyScanBackoffMs
    this.now = options.now || (() => Date.now())
    this.onNotification = options.onNotification
    this.onRecoveryCandidate =
      options.onRecoveryCandidate || ((candidate) => void upsertRecoveryCandidate(candidate).catch(() => {}))
    this.onPaneRemoved = options.onPaneRemoved
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
    const generation = ++this.runGeneration
    this.scanAbort = new AbortController()
    this.lastPushSubscribers = this.hasPushSubscribers()
    if (!this.unsubscribePushChange) this.unsubscribePushChange = onPushSubscriberChange(() => this.syncPushCadence())
    // web-push 订阅表只读探测不阻塞启动：start() 的时序被「stop 打断启动」类用例依赖，
    // 探测落地后 syncPushCadence 自行把怠速档提到 push 档（毫秒级延迟，节拍是秒级）
    void refreshPushSubscriberCount()
      .then(() => this.syncPushCadence())
      .catch(() => {})
    this.startPromise = (async () => {
      await this.refreshHosts(false)
      await Promise.all([...this.hosts.keys()].map((hostId) => this.pollHost(hostId)))
      if (this.running && this.runGeneration === generation) {
        // 覆盖前先清：即使将来有别的路径重复挂，也不会留下没人引用的定时器
        if (this.hostRefreshTimer) clearInterval(this.hostRefreshTimer)
        this.hostRefreshTimer = setInterval(() => void this.refreshHosts(), this.hostRefreshMs)
      }
    })()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  stop() {
    this.running = false
    // 让在飞的 start 失效：它的 setInterval 不允许在 stop 之后落地
    this.runGeneration++
    // 先掐在跑的扫描：ssh 子进程活着会让宿主进程迟迟退不掉
    this.scanAbort?.abort()
    this.scanAbort = null
    this.unsubscribePushChange?.()
    this.unsubscribePushChange = null
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

  // 三档轮询：
  //   有监听者（WS/agent.wait）→ intervalMs 快档，交互态要即时；
  //   无监听者但有 web-push 订阅者 → pushPollMs，通知延迟等于节拍，不能按怠速走；
  //   都没有 → idleMs 怠速（默认 30s），空闲时远程轮询降 ~20×
  private currentPollMs() {
    if (this.listeners.size) return this.intervalMs
    return this.hasPushSubscribers() ? this.pushPollMs : this.idleMs
  }
  // 单 host 的实际扫描间隔：档位节拍之上叠加空扫退避。
  // 只对远端生效——local 的「扫描」就是一次 tmux execFile，退避没有收益还拖慢本机可观测性。
  private pollIntervalMs(hostId: string, state: MonitorHostState) {
    const base = this.currentPollMs()
    if (hostId === 'local') return base
    return Math.max(base, this.emptyScanBackoff(state.emptyScans))
  }
  // 每次扫描后都要重新挂表：退避档位是随扫描结果变化的，沿用旧定时器会一直卡在原档
  private armHostTimer(hostId: string, state: MonitorHostState) {
    if (state.timer) clearInterval(state.timer)
    state.timer = this.running
      ? setInterval(() => void this.pollHost(hostId), this.pollIntervalMs(hostId, state))
      : null
  }
  // 排障/测试只读：当前 host 的扫描间隔（未跟踪的 host 回 null）
  getPollIntervalMs(hostId: string) {
    const state = this.hosts.get(hostId)
    return state ? this.pollIntervalMs(hostId, state) : null
  }
  // web-push 订阅表变化时只在「有/无」翻转时重排节拍，避免每次注册都重置定时器
  private syncPushCadence() {
    const next = this.hasPushSubscribers()
    if (next === this.lastPushSubscribers) return
    this.lastPushSubscribers = next
    this.refreshPollCadence()
  }
  private refreshPollCadence() {
    if (!this.running) return
    for (const [hostId, state] of this.hosts) this.armHostTimer(hostId, state)
    if (this.listeners.size) for (const hostId of this.hosts.keys()) void this.pollHost(hostId)
  }

  // 扁平化全机队 pane 状态：待办队列用它把「通知里的旧状态」纠正成实时状态
  getAllStates() {
    const all: AgentPaneState[] = []
    for (const state of this.hosts.values()) if (state.initialized) all.push(...state.agents.values())
    return all
  }

  getStates(hostId: string) {
    const state = this.hosts.get(hostId)
    return state?.initialized ? sortAgents(state.agents.values()) : null
  }

  // host 级 revision：推式帧里的排障字段（内容未变则不涨，见 applyScan）
  getRevision(hostId: string) {
    return this.hosts.get(hostId)?.revision ?? 0
  }

  getSessionStates(hostId: string, sessionName: string) {
    return this.getStates(hostId)?.filter((pane) => pane.sessionName === sessionName) ?? null
  }

  // 任务号写入后的就地更新：返回 false 表示该 pane 尚未被 monitor 跟踪（写入本身仍成功）。
  // 除 patch 缓存外还登记 taskOverrides，挡住「扫描早于写入、落地晚于写入」把值盖回去；
  // 同时广播一次 changed，让开着 Fleet 面板的人立刻看到任务号，而不是等下一轮扫描。
  notePaneTask(hostId: string, tmuxPaneId: string, task: string) {
    const state = this.hosts.get(hostId)
    const paneId = `${hostId}:${tmuxPaneId}`
    const current = state?.agents.get(paneId)
    if (!state?.initialized || !current) return false
    const nextTask = task || undefined
    this.taskOverrides.set(paneId, { task: nextTask, at: this.now() })
    if ((current.task || '') === (nextTask || '')) return true
    const pane = { ...current, task: nextTask }
    state.agents.set(paneId, pane)
    state.revision += 1
    this.emit({
      type: 'agent_status_changed',
      initial: false,
      hostId,
      sessionName: pane.sessionName,
      pane,
      // 复用 'changed' 作为事件种类：task 不是 AgentEvent，也不该被当作状态迁移解释
      eventId: this.eventId(hostId, pane, 'changed', state.revision),
    })
    return true
  }

  async pollNow(hostId: string) {
    await this.pollHost(hostId)
  }

  /**
   * 外部动作（终端 attach、agent 协议事件进站）本身就是「这个 host 上可能刚起了 agent」的信号：
   * 立刻清掉空扫退避档位并排一轮扫描，别让用户等满 120s 的降频档。
   * 只重置档位，不假设能扫到——agent 还没起来就还是空，从第 0 轮重新计。
   * 未跟踪的 host 直接忽略：refreshHosts 发现新 host 时本来就会立刻扫。
   */
  noteHostActivity(hostId: string) {
    const state = this.hosts.get(hostId)
    if (!state || !this.running) return
    state.emptyScans = 0
    this.armHostTimer(hostId, state)
    // 已在扫时 pollHost 自己会跳过，不用在外面判 state.scanning
    void this.pollHost(hostId)
  }

  ingestProtocolEvent(event: AgentProtocolEvent) {
    if (!event.hostId || !event.eventId) return null
    // 事件能进来说明该 host 上确实有 agent 在跑：若上次扫描还是空集（退避档位已抬高），
    // 这次进站就是最便宜的唤醒信号。没有退避时不必多说一句（忙 host 每拍都在扫）
    if ((this.hosts.get(event.hostId)?.emptyScans ?? 0) > 0) this.noteHostActivity(event.hostId)
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
      // 该 pane 仍挂着的 completed 协议覆盖一并清除：不清则下一次 scan 会把
      // TTL 内的旧 completed 重新叠回 done，「标记已读」在协议链路下瞬间失效
      for (const [key, event] of state.protocolEvents)
        if (matchesProtocolEvent(event, current) && protocolAgentStatus(event) === 'done')
          state.protocolEvents.delete(key)
      const marked = markAgentPaneSeen(paneId)
      // 无记录但 monitor 仍显示 done（纯协议覆盖/记录已淘汰）→ 用当前态合成 idle 收口
      const next = marked || (current.agentStatus === 'done' ? { ...current, agentStatus: 'idle' as const } : null)
      if (!next || samePane(current, next)) return null
      const pane = { ...next, stateSeq: ++nextStateSeq }
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
        emptyScans: 0,
      }
      this.pendingProtocolEvents.delete(hostId)
      this.hosts.set(hostId, state)
      if (this.running) {
        this.armHostTimer(hostId, state)
        if (pollNewHosts) void this.pollHost(hostId)
      }
    }
    for (const [hostId, state] of this.hosts) {
      if (nextIds.has(hostId)) continue
      if (state.timer) clearInterval(state.timer)
      for (const pane of state.agents.values()) {
        forgetAgentPane(pane.paneId)
        this.recordRecoveryCandidate(hostId, pane, 'host_removed')
        // 待办收口：pane 没了就再也扫不到，通知流也不会再为它产生事件
        try {
          this.onPaneRemoved?.({ hostId, paneId: pane.paneId, sessionName: pane.sessionName, reason: 'host_removed' })
        } catch {}
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
      const agents = await this.scan(hostId, this.scanAbort?.signal)
      if (!this.running || this.hosts.get(hostId) !== state) return
      this.applyScan(hostId, state, agents)
    } catch {
      if (!this.running || this.hosts.get(hostId) !== state) return
      this.applyFailure(hostId, state)
    } finally {
      state.scanning = false
      // 空扫轮数刚变过：下一拍必须按新档位挂，否则要等旧定时器自然到期才生效
      if (this.running && this.hosts.get(hostId) === state) this.armHostTimer(hostId, state)
    }
  }

  private applyScan(hostId: string, state: MonitorHostState, agents: AgentPaneState[]) {
    // 空集 = 该 host 上没有 agent pane；连续空轮数决定还要不要按满频付 ssh
    state.emptyScans = agents.length === 0 ? state.emptyScans + 1 : 0
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
    // 清掉已消失 pane 的覆盖项，避免 map 随 pane 累积
    for (const key of this.taskOverrides.keys()) if (!next.has(key)) this.taskOverrides.delete(key)
    for (const raw of next.values()) {
      const override = this.taskOverrides.get(raw.paneId)
      const pane = override && this.now() - override.at < taskOverrideTtlMs ? { ...raw, task: override.task } : raw
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
      try {
        this.onPaneRemoved?.({
          hostId,
          paneId: previous.paneId,
          sessionName: previous.sessionName,
          reason: 'pane_exited',
        })
      } catch {}
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
    // 出错 ≠ 空：故障主机要按满频重试，不能借空扫退避把它藏起来
    state.emptyScans = 0
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

export const agentMonitor = new AgentMonitor({
  onNotification: (event) => void persistAgentNotification(event),
  onPaneRemoved: ({ hostId, paneId }) => void closeAgentTodosForPane(hostId, paneId).catch(() => {}),
})
