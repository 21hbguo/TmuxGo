import type { AgentEvent, AgentPaneState, AgentPhase, AgentStatus } from './agent-state.js'

// 机队读模型（docs/design/fleet-orchestration.md §4.1）：
// agent 侧要能回答「现在谁在跑、各自绑了什么任务、谁卡住了」，而现有控制面只有 pane 级原语。
// 这里只做「把 monitor 缓存投影成可寻址列表」——不触发扫描、不落盘、不含屏幕内容。

// 与前端 lib/fleet.ts 的 RANK 同序：人看到的顺序和 agent 拿到的顺序必须一致，
// 否则两边对「谁最急」的判断会分叉。done 排在 working 前是有意的——跑完等验收比在跑更该被看见
const RANK: Record<AgentStatus, number> = { blocked: 1, done: 3, working: 4, idle: 6, unknown: 7 }
// phase/lastEvent 为 failed 的条目不是独立 status，按 2 档参与排序与过滤
const RANK_FAILED = 2
const FLEET_ATTENTION_MAX_RANK = RANK_FAILED

export interface FleetEntry {
  paneId: string
  hostId: string
  sessionName: string
  agent: string
  agentStatus: AgentStatus
  phase?: AgentPhase
  lastEvent?: AgentEvent
  // @tmuxgo_task 原文去空白；未绑定时为 null（空串不出现，理由见 routes/panes.ts）
  task: string | null
  // agent 最近事件消息，可能为空——不据此判定状态
  message: string | null
  confidence?: AgentPaneState['confidence']
  since: string | null
  updatedAt: string | null
  // blocked 或 failed：这两档需要人介入，agent 侧据此决定「叫不叫人」
  needsHuman: boolean
  self: boolean
}

export interface FleetSummary {
  idle: number
  working: number
  blocked: number
  done: number
  unknown: number
  total: number
}

export interface FleetListResult {
  panes: FleetEntry[]
  summary: FleetSummary
  truncated: boolean
}

export const FLEET_DEFAULT_LIMIT = 200
export const FLEET_MAX_LIMIT = 500

export interface FleetQuery {
  hostIds?: string[]
  statuses?: AgentStatus[]
  task?: string
  agent?: string
  limit?: number
  // 调用方自报的 pane（MCP 从 TMUX_PANE 推导）：只用于标记 self，不参与任何鉴权
  selfPaneId?: string
  // session 白名单（TMUX_WEB_ALLOWED_SESSIONS / 受限 scope）：返回 false 的行直接不可见
  allowSession?: (hostId: string, sessionName: string) => boolean
}

function hostIdOf(state: AgentPaneState) {
  const separator = state.paneId.indexOf(':')
  return separator > 0 ? state.paneId.slice(0, separator) : 'local'
}

function rankOf(entry: Pick<FleetEntry, 'agentStatus' | 'phase' | 'lastEvent'>) {
  if (entry.agentStatus === 'blocked') return RANK.blocked
  if (entry.phase === 'failed' || entry.lastEvent === 'failed') return RANK_FAILED
  return RANK[entry.agentStatus] ?? RANK.unknown
}

function normalizeTask(task: string | undefined | null) {
  const value = typeof task === 'string' ? task.trim() : ''
  return value || null
}

function samePane(state: AgentPaneState, selfPaneId: string | undefined) {
  if (!selfPaneId) return false
  // 调用方可能只知道 TMUX_PANE（%3）也可能知道完整 host:%3；两种写法都认
  return selfPaneId.includes(':') ? state.paneId === selfPaneId : state.tmuxPaneId === selfPaneId
}

// since 缺失时排到最后：没有时间戳的条目无法比较紧迫度，不能抢在已知卡了很久的前面
function sortKey(entry: FleetEntry) {
  return [rankOf(entry), entry.since ? Date.parse(entry.since) : Number.MAX_SAFE_INTEGER] as const
}

export function buildFleetList(states: AgentPaneState[], query: FleetQuery = {}): FleetListResult {
  const statuses = query.statuses?.length ? new Set(query.statuses) : null
  const hostIds = query.hostIds?.length ? new Set(query.hostIds) : null
  const task = normalizeTask(query.task)
  const agent = (query.agent || '').trim().toLowerCase()
  const limit = Math.min(Math.max(1, query.limit ?? FLEET_DEFAULT_LIMIT), FLEET_MAX_LIMIT)

  const matched: FleetEntry[] = []
  for (const state of states) {
    const hostId = hostIdOf(state)
    if (hostIds && !hostIds.has(hostId)) continue
    if (query.allowSession && !query.allowSession(hostId, state.sessionName)) continue
    if (statuses && !statuses.has(state.agentStatus)) continue
    if (task && normalizeTask(state.task) !== task) continue
    if (agent && (state.agent || '').toLowerCase() !== agent) continue
    const entry: FleetEntry = {
      paneId: state.paneId || `${hostId}:${state.tmuxPaneId}`,
      hostId,
      sessionName: state.sessionName,
      agent: state.agent || '',
      agentStatus: state.agentStatus,
      phase: state.phase,
      lastEvent: state.lastEvent,
      task: normalizeTask(state.task),
      message: (state.message || '').trim() || null,
      confidence: state.confidence,
      since: state.since || null,
      updatedAt: state.updatedAt || null,
      needsHuman: false,
      self: samePane(state, query.selfPaneId),
    }
    entry.needsHuman = rankOf(entry) <= FLEET_ATTENTION_MAX_RANK
    matched.push(entry)
  }

  matched.sort((left, right) => {
    const [leftRank, leftSince] = sortKey(left)
    const [rightRank, rightSince] = sortKey(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    if (leftSince !== rightSince) return leftSince - rightSince
    return left.paneId.localeCompare(right.paneId)
  })

  // summary 描述「匹配集合」而不是截断后的页：调用方要先知道总量再决定翻页
  const summary = matched.reduce<FleetSummary>(
    (acc, entry) => {
      acc[entry.agentStatus] += 1
      acc.total += 1
      return acc
    },
    { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 },
  )

  return { panes: matched.slice(0, limit), summary, truncated: matched.length > limit }
}
