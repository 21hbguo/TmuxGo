import type { AgentPaneState } from '@/types'

// 与服务端 AGENT_PROTO_VERSION 对齐；服务端拒绝更高版本，前端只声明自己理解的版本
export const AGENT_PROTO_VERSION = 1
// 连续多少次断号重同步仍失败就放弃推式通道，回落到 REST 快照轮询
export const AGENT_FEED_RESYNC_MAX = 3

export type AgentFeedMode = 'full' | 'delta' | 'pulse'
export interface AgentFeedRemoved {
  paneId: string
  sessionName?: string
  reason?: string
}
export interface AgentStateFrame {
  type: 'agent_state'
  agentProtoVersion?: number
  subId: string
  hostId: string
  mode: AgentFeedMode
  seq: number
  stateSeq?: number
  revision?: number
  changed?: AgentPaneState[]
  removed?: AgentFeedRemoved[]
}
export interface AgentFeedUpdate {
  hostId: string
  // pulse 只带水位，不进这里——视图变更只有整帧替换与增量两种
  mode: 'full' | 'delta'
  changed: AgentPaneState[]
  removed: AgentFeedRemoved[]
  stateSeq: number
  revision?: number
}
export interface AgentFeedPort {
  // 返回 false 表示 socket 未就绪（订阅没发出去，调用方稍后重试）
  send: (frame: Record<string, unknown>) => boolean
  onUpdate: (update: AgentFeedUpdate) => void
  // 重同步耗尽：调用方应回落 REST 快照，并可用 subscribe() 重新建订阅（seq 从头算）
  onDegraded: (hostId: string) => void
}
interface AgentSub {
  hostId: string
  // 服务端回帧才带来 subId；在此之前收到断号无法重同步，只能丢订阅重订
  subId: string | null
  lastSeq: number
  stateSeq: number
  resyncAttempts: number
}
// 推送健康度注册表（hostId 维度）：REST 侧据此决定还要不要自带 agents。
// 只有「订阅建立且最近一次降级已恢复」才算健康——降级期间立刻回落到带 agents 的
// REST，避免推送断了界面还停在旧状态。用模块级 Set 而不是实例状态，是因为
// AgentFeedClient 活在组件 ref 里，而 useSessions 的 queryFn 读不到组件实例。
const freshHosts = new Set<string>()

export function isAgentFeedFresh(hostId: string) {
  return freshHosts.has(hostId)
}

// 仅供测试与连接级重置清理用
export function resetAgentFeedFreshness() {
  freshHosts.clear()
}

// 订阅型 agent 通道的客户端状态机。
// 三套序各管一件事：hostId 找订阅、seq 判连续（断号→resync）、stateSeq 判新鲜度（合并交给视图层）。
// 以 hostId 为主键而不是 subId：重连/重订后 subId 会变，hostId 才是订阅意图的稳定标识
export class AgentFeedClient {
  private readonly subs = new Map<string, AgentSub>()
  constructor(private readonly port: AgentFeedPort) {}

  get size() {
    return this.subs.size
  }

  has(hostId: string) {
    return this.subs.has(hostId)
  }

  // 当前有订阅的 host 列表：宿主列表变化时用来退订已消失的 host
  hosts() {
    return [...this.subs.keys()]
  }

  getSubId(hostId: string) {
    return this.subs.get(hostId)?.subId ?? null
  }

  getStateSeq(hostId: string) {
    return this.subs.get(hostId)?.stateSeq ?? -1
  }

  subscribe(hostId: string) {
    if (!hostId || this.subs.has(hostId)) return
    this.subs.set(hostId, { hostId, subId: null, lastSeq: 0, stateSeq: -1, resyncAttempts: 0 })
    const ok = this.port.send({
      type: 'agent_subscribe',
      agentProtoVersion: AGENT_PROTO_VERSION,
      hostId,
      // 整 host 订阅：需要 session 级过滤时由服务端按访问范围静默收敛
      needFull: true,
      wantNotifications: true,
    })
    // socket 没开：撤掉占位，等就绪事件重试（否则会留下永远收不到帧的"幽灵订阅"）
    if (!ok) {
      this.subs.delete(hostId)
      freshHosts.delete(hostId)
      return
    }
    freshHosts.add(hostId)
  }

  unsubscribe(hostId: string) {
    const sub = this.subs.get(hostId)
    if (!sub) return
    this.subs.delete(hostId)
    freshHosts.delete(hostId)
    if (sub.subId) this.port.send({ type: 'agent_unsubscribe', subId: sub.subId })
  }

  // 连接级重置：服务端订阅随 socket 消失，本地 seq 基线也必须清零
  reset() {
    this.subs.clear()
    freshHosts.clear()
  }

  handleFrame(frame: AgentStateFrame) {
    const sub = this.subs.get(frame.hostId)
    if (!sub) return
    // 重订过渡期可能收到旧订阅的残留帧，subId 对不上就不认
    if (sub.subId && frame.subId && sub.subId !== frame.subId) return
    const seq = Number(frame.seq)
    if (!Number.isFinite(seq)) return
    // full 是替换式基线（首帧、重同步重放、重订快照都用它），seq 允许跳变：
    // 服务端 seq 在"发帧时"自增，重同步重放必然跳号，按连续要求收会把重放帧全丢掉
    const isFull = frame.mode === 'full'
    if (!isFull) {
      if (sub.lastSeq && seq <= sub.lastSeq) return
      if (sub.lastSeq && seq !== sub.lastSeq + 1) {
        this.requestResync(sub)
        return
      }
    }
    sub.subId = frame.subId || sub.subId
    sub.lastSeq = seq
    sub.resyncAttempts = 0
    // 收到任何被接受的帧都说明订阅活着；重同步成功同样走这里恢复健康度
    freshHosts.add(sub.hostId)
    const stateSeq = Number(frame.stateSeq)
    if (Number.isFinite(stateSeq)) sub.stateSeq = Math.max(sub.stateSeq, stateSeq)
    // pulse 只推进水位：明细由消费方按需 resync 或等下一次变化
    if (frame.mode === 'pulse') return
    this.port.onUpdate({
      hostId: sub.hostId,
      mode: frame.mode === 'full' ? 'full' : 'delta',
      changed: Array.isArray(frame.changed) ? frame.changed : [],
      removed: Array.isArray(frame.removed) ? frame.removed : [],
      stateSeq: sub.stateSeq,
      revision: frame.revision,
    })
  }

  private requestResync(sub: AgentSub) {
    sub.resyncAttempts += 1
    if (sub.resyncAttempts > AGENT_FEED_RESYNC_MAX || !sub.subId) {
      this.subs.delete(sub.hostId)
      freshHosts.delete(sub.hostId)
      this.port.onDegraded(sub.hostId)
      return
    }
    this.port.send({ type: 'agent_resync', subId: sub.subId })
  }
}

export function isAgentStateFrame(value: unknown): value is AgentStateFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<AgentStateFrame>
  return (
    frame.type === 'agent_state' &&
    typeof frame.subId === 'string' &&
    typeof frame.hostId === 'string' &&
    typeof frame.seq === 'number' &&
    (frame.mode === 'full' || frame.mode === 'delta' || frame.mode === 'pulse')
  )
}
