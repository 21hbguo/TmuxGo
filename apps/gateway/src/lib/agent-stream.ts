import { randomBytes } from 'crypto'
import { scopeAllowsHost, scopeAllowsSession, type AccessScope } from './access-scope.js'
import type { AgentMonitorEvent } from './agent-monitor.js'
import type { AgentPaneState } from './agent-state.js'
import { recordStreamMetric } from './perf-metrics.js'

// AgentFeed：agent 状态聚合的推式订阅通道（设计文档 §2/§3.1）。
// 与 legacy agent_status_* 帧并行（S1 双发期）：本模块只负责新协议，
// 旧帧仍由 routes/stream.ts 的 monitor listener 直发，两者互不干扰。
export const AGENT_PROTO_VERSION = 1
// 合并窗：scan 一轮可能带多个 pane 变化，逐条发会把帧数放大到 pane 数量级；
// 100ms 内同 pane 只留最新，跨轮次自然合并
export const AGENT_SUB_FRAME_MS = 100
// 单连接订阅上限：订阅按 host 计，8 条足够覆盖多 host + 分屏，超出视为客户端异常
export const AGENT_SUB_MAX = 8
// 单帧 changed 上限：超出拆帧保持 seq 连号，避免弱网下一帧几十 KB 卡住发送链
export const AGENT_SUB_FRAME_MAX_PANES = 64
export const AGENT_SUB_SESSION_MAX = 64

export type AgentFeedErrorCode =
  | 'AGENT_PROTO_VERSION_UNSUPPORTED'
  | 'AGENT_SUBSCRIBE_INVALID'
  | 'AGENT_SCOPE_DENIED'
  | 'AGENT_SUB_LIMIT'
  | 'AGENT_RESYNC_REQUIRED'

export class AgentFeedError extends Error {
  constructor(
    readonly code: AgentFeedErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AgentFeedError'
  }
}

export interface AgentFeedRemoved {
  paneId: string
  sessionName: string
  reason: string
  stateSeq?: number
}
export interface AgentFeedFrame {
  type: 'agent_state'
  agentProtoVersion: number
  subId: string
  seq: number
  // full = 替换式全量（首帧/重同步/重连），delta = 合并增量，pulse = 拥塞脉冲（只给水位）
  mode: 'full' | 'delta' | 'pulse'
  hostId: string
  revision: number
  // 本帧最大 pane.stateSeq。跨 host 跳号属正常（全局计数器），只能做陈旧判定，
  // 不能当连号用——连号只认 seq
  stateSeq: number
  changed: AgentPaneState[]
  removed: AgentFeedRemoved[]
  timestamp: string
}
export interface AgentFeedNotificationFrame {
  type: 'agent_notification'
  agentProtoVersion: number
  subId: string
  hostId: string
  sessionName: string
  pane: AgentPaneState
  eventId: string
  timestamp: string
}
export type AgentFeedOutbound = AgentFeedFrame | AgentFeedNotificationFrame

export interface AgentSubscribeInput {
  hostId: string
  agentProtoVersion?: number
  sessions?: string[]
  needFull?: boolean
  wantNotifications?: boolean
}
export interface AgentFeedOptions {
  send: (frame: AgentFeedOutbound) => void
  // monitor 物化状态（null = 该 host 尚未初始化）
  getStates: (hostId: string) => AgentPaneState[] | null
  // host 级 revision，仅排障用；缺省退化为帧内 max(pane.revision)
  getRevision?: (hostId: string) => number
  // 拥塞判据（socket bufferedAmount 超水位）：true 时 delta 降级为 pulse
  isCongested?: () => boolean
  scope?: AccessScope
  // share 观众不推 agent 帧（与 legacy 扇出一致：消息正文/title 不泄露给持链接者）
  shareTicket?: boolean
  now?: () => number
  frameMs?: number
}

interface AgentSubscription {
  subId: string
  hostId: string
  // null = scope 允许的全部 session
  sessions: Set<string> | null
  seq: number
  wantNotifications: boolean
  pendingChanged: Map<string, AgentPaneState>
  pendingRemoved: Map<string, AgentFeedRemoved>
  // 本轮窗口内收到的更新条数（含被覆盖的旧值），用于度量合并省掉的帧
  pendingUpdates: number
  timer: ReturnType<typeof setTimeout> | null
}

const hostIdPattern = /^[A-Za-z0-9._-]{1,64}$/

export class AgentFeed {
  private readonly subs = new Map<string, AgentSubscription>()
  private readonly now: () => number
  private readonly frameMs: number
  private disposed = false

  constructor(private readonly options: AgentFeedOptions) {
    this.now = options.now || (() => Date.now())
    this.frameMs = Math.max(0, options.frameMs ?? AGENT_SUB_FRAME_MS)
  }

  get size() {
    return this.subs.size
  }

  subscribe(input: AgentSubscribeInput) {
    if (this.options.shareTicket)
      throw new AgentFeedError('AGENT_SCOPE_DENIED', 'Access scope does not allow agent state')
    // 缺省版本按 v1 处理：声明 legacy 的方式是不发 agent_subscribe（旧客户端本就不发）
    const version = input.agentProtoVersion ?? AGENT_PROTO_VERSION
    if (version !== AGENT_PROTO_VERSION)
      throw new AgentFeedError('AGENT_PROTO_VERSION_UNSUPPORTED', `Unsupported agent protocol version: ${version}`)
    if (typeof input.hostId !== 'string' || !hostIdPattern.test(input.hostId))
      throw new AgentFeedError('AGENT_SUBSCRIBE_INVALID', 'Invalid agent subscribe hostId')
    if (input.sessions && input.sessions.length > AGENT_SUB_SESSION_MAX)
      throw new AgentFeedError('AGENT_SUBSCRIBE_INVALID', 'Too many sessions in agent subscribe')
    if (this.subs.size >= AGENT_SUB_MAX)
      throw new AgentFeedError('AGENT_SUB_LIMIT', `Too many agent subscriptions (max ${AGENT_SUB_MAX})`)
    const scope = this.options.scope
    if (scope && !scopeAllowsHost(scope, input.hostId))
      throw new AgentFeedError('AGENT_SCOPE_DENIED', 'Access scope does not allow this host')
    // session 白名单按 scope 静默收敛：越权项直接剔除而不是报错，
    // 否则等于给受限身份一个"哪些 session 存在"的探测 oracle
    const sessions = input.sessions
      ? new Set(
          input.sessions.filter(
            (name) => typeof name === 'string' && (!scope || scopeAllowsSession(scope, input.hostId, name)),
          ),
        )
      : null
    const sub: AgentSubscription = {
      subId: 'as_' + randomBytes(3).toString('hex'),
      hostId: input.hostId,
      sessions,
      seq: 0,
      wantNotifications: input.wantNotifications !== false,
      pendingChanged: new Map(),
      pendingRemoved: new Map(),
      pendingUpdates: 0,
      timer: null,
    }
    this.subs.set(sub.subId, sub)
    // metric 是跨连接的全局 gauge：按增删做增量，不能写本实例的 size
    recordStreamMetric('agentSubs', 1)
    // needFull=false 是"只要通知与水位"的轻量订阅：不发 pane 明细，只给一条 pulse 让客户端拿到 stateSeq
    if (input.needFull === false) this.sendFrame(sub, 'pulse', [], [], this.hostStateSeq(sub.hostId))
    else this.sendFull(sub)
    return { subId: sub.subId, seq: sub.seq }
  }

  resync(subId: string) {
    const sub = this.subs.get(subId)
    if (!sub) throw new AgentFeedError('AGENT_RESYNC_REQUIRED', 'Unknown agent subscription')
    recordStreamMetric('agentResyncRequests')
    this.sendFull(sub)
    return { subId: sub.subId, seq: sub.seq }
  }

  unsubscribe(subId: string) {
    const sub = this.subs.get(subId)
    if (!sub) return false
    this.clearPending(sub)
    this.subs.delete(subId)
    recordStreamMetric('agentSubs', -1)
    return true
  }

  // monitor 事件的唯一入口：调用方保证每连接只挂一个 monitor listener（快/慢档按 listener 数算）
  ingest(event: AgentMonitorEvent) {
    if (this.disposed || !this.subs.size) return
    switch (event.type) {
      case 'agent_status_snapshot': {
        for (const sub of this.subs.values()) if (sub.hostId === event.hostId) this.sendFull(sub, event.agents)
        break
      }
      case 'agent_status_changed': {
        for (const sub of this.subs.values())
          if (this.matches(sub, event.hostId, event.pane)) this.queuePane(sub, event.pane)
        break
      }
      case 'agent_status_removed': {
        for (const sub of this.subs.values()) {
          if (!this.matchesSession(sub, event.hostId, event.sessionName)) continue
          this.queueRemoved(sub, {
            paneId: event.paneId,
            sessionName: event.sessionName,
            reason: event.reason,
          })
        }
        break
      }
      case 'agent_notification': {
        for (const sub of this.subs.values()) {
          if (!sub.wantNotifications || !this.matches(sub, event.hostId, event.pane)) continue
          this.options.send({
            type: 'agent_notification',
            agentProtoVersion: AGENT_PROTO_VERSION,
            subId: sub.subId,
            hostId: event.hostId,
            sessionName: event.sessionName,
            pane: event.pane,
            eventId: event.eventId,
            timestamp: new Date(this.now()).toISOString(),
          })
          recordStreamMetric('agentFramesSent')
        }
        break
      }
      // agent_monitor_error 不新增 v1 帧：前端已在消费 legacy 形状（agent-monitor-error），
      // 再发一份只会重复告警；错误码语义留待 v2 统一
      default:
        break
    }
  }

  dispose() {
    this.disposed = true
    for (const sub of this.subs.values()) this.clearPending(sub)
    recordStreamMetric('agentSubs', -this.subs.size)
    this.subs.clear()
  }

  private matchesSession(sub: AgentSubscription, hostId: string, sessionName: string) {
    if (sub.hostId !== hostId) return false
    if (sub.sessions && !sub.sessions.has(sessionName)) return false
    // 二次过 scope：订阅建立后 scope 可能被运维改动，扇出时再判一次
    const scope = this.options.scope
    if (scope && !scopeAllowsSession(scope, hostId, sessionName)) return false
    return true
  }

  private matches(sub: AgentSubscription, hostId: string, pane: AgentPaneState) {
    return this.matchesSession(sub, hostId, pane.sessionName)
  }

  private hostStateSeq(hostId: string) {
    const states = this.options.getStates(hostId) || []
    return states.reduce((max, pane) => Math.max(max, pane.stateSeq ?? -1), -1)
  }

  private queuePane(sub: AgentSubscription, pane: AgentPaneState) {
    const pending = sub.pendingChanged.get(pane.paneId)
    // 同窗内同一 pane 多帧：stateSeq 单调，旧值直接丢（无 stateSeq 的旧链路 pane 按到达序覆盖）
    if (pending && (pending.stateSeq ?? -1) > (pane.stateSeq ?? -1)) return
    sub.pendingChanged.set(pane.paneId, pane)
    sub.pendingUpdates += 1
    // 同一 pane 已有待发 removed 时，changed 表示"pane 又回来了"，撤掉 removed
    sub.pendingRemoved.delete(pane.paneId)
    this.schedule(sub)
  }

  private queueRemoved(sub: AgentSubscription, removed: AgentFeedRemoved) {
    sub.pendingChanged.delete(removed.paneId)
    sub.pendingRemoved.set(removed.paneId, removed)
    sub.pendingUpdates += 1
    this.schedule(sub)
  }

  private schedule(sub: AgentSubscription) {
    if (sub.timer) return
    if (this.frameMs === 0) {
      this.flush(sub)
      return
    }
    sub.timer = setTimeout(() => {
      sub.timer = null
      this.flush(sub)
    }, this.frameMs)
  }

  private flush(sub: AgentSubscription) {
    if (this.disposed || !this.subs.has(sub.subId)) return
    const changed = [...sub.pendingChanged.values()]
    const removed = [...sub.pendingRemoved.values()]
    const updates = sub.pendingUpdates
    sub.pendingChanged.clear()
    sub.pendingRemoved.clear()
    sub.pendingUpdates = 0
    if (!changed.length && !removed.length) return
    const stateSeq = Math.max(
      -1,
      ...changed.map((pane) => pane.stateSeq ?? -1),
      ...removed.map((item) => item.stateSeq ?? -1),
    )
    // 拥塞时只发水位脉冲：delta 挤在终端输出后面只会把队列拖长，
    // 客户端拿到 pulse 后自行决定是否 resync（一次往返，比慢速灌帧便宜）
    if (this.options.isCongested?.()) {
      this.sendFrame(sub, 'pulse', [], [], stateSeq)
      // 脉冲把整窗更新压成一条：省下的条数就是合并收益
      if (updates) recordStreamMetric('agentFramesCoalesced', updates)
      return
    }
    // 拆帧保持 seq 连号；removed 跟着第一帧走，保证客户端在同一轮里先撤后增的语义不乱
    for (let index = 0; index < changed.length; index += AGENT_SUB_FRAME_MAX_PANES) {
      const chunk = changed.slice(index, index + AGENT_SUB_FRAME_MAX_PANES)
      this.sendFrame(sub, 'delta', chunk, index === 0 ? removed : [], stateSeq)
    }
    if (!changed.length) this.sendFrame(sub, 'delta', [], removed, stateSeq)
    const emitted = changed.length + removed.length
    if (updates > emitted) recordStreamMetric('agentFramesCoalesced', updates - emitted)
  }

  private sendFull(sub: AgentSubscription, agents?: AgentPaneState[]) {
    // full 是替换式：先清掉待发增量，避免 full 之后又补一条旧 delta；被覆盖的更新计为合并收益
    if (sub.pendingUpdates) recordStreamMetric('agentFramesCoalesced', sub.pendingUpdates)
    this.clearPending(sub)
    const states = (agents || this.options.getStates(sub.hostId) || []).filter((pane) =>
      this.matches(sub, sub.hostId, pane),
    )
    // full 不拆帧：替换语义要求原子，pane 数上限由宿主 tmux 会话规模决定（几十条）
    this.sendFrame(
      sub,
      'full',
      states,
      [],
      states.reduce((max, pane) => Math.max(max, pane.stateSeq ?? -1), -1),
    )
  }

  private sendFrame(
    sub: AgentSubscription,
    mode: AgentFeedFrame['mode'],
    changed: AgentPaneState[],
    removed: AgentFeedRemoved[],
    stateSeq: number,
  ) {
    sub.seq += 1
    const frame: AgentFeedFrame = {
      type: 'agent_state',
      agentProtoVersion: AGENT_PROTO_VERSION,
      subId: sub.subId,
      seq: sub.seq,
      mode,
      hostId: sub.hostId,
      revision:
        this.options.getRevision?.(sub.hostId) ?? changed.reduce((max, pane) => Math.max(max, pane.revision), 0),
      stateSeq,
      changed,
      removed,
      timestamp: new Date(this.now()).toISOString(),
    }
    this.options.send(frame)
    recordStreamMetric('agentFramesSent')
    // 体积指标要的是 wire 量级：这里先序列化一次取长度（StreamSession 出站时会再序列化）
    recordStreamMetric('agentFrameBytes', JSON.stringify(frame).length)
  }

  private clearPending(sub: AgentSubscription) {
    if (sub.timer) clearTimeout(sub.timer)
    sub.timer = null
    sub.pendingChanged.clear()
    sub.pendingRemoved.clear()
    sub.pendingUpdates = 0
  }
}
