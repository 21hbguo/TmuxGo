import type {
  AgentEvent,
  AgentPaneState,
  AgentPhase,
  AgentRecoveryCandidate,
  AgentStatus,
  Host,
  Pane,
  Session,
} from '@/types'

// fleet 总览的纯逻辑层：行拼装、排序、过滤、相对时长。全部无副作用，方便单测锁定语义
// （docs/architecture/agent-observability-v2.md §3.3-3.4）。

export interface FleetRow {
  /** hostId:paneId，跨 host 唯一；React key 与恢复候选关联都用它 */
  key: string
  hostId: string
  hostName: string
  hostStatus: Host['status']
  hostChannel: Host['connectionMode']
  sessionName: string
  sessionId: string
  paneId: string
  tmuxPaneId: string
  /** pane 序号未在 agents 帧里携带时为 null，表格显示 — */
  paneIndex: number | null
  agent: string | null
  task: string | null
  status: AgentStatus
  phase?: AgentPhase
  lastEvent?: AgentEvent
  since: string | null
  updatedAt: string | null
  recovery: AgentRecoveryCandidate | null
}

export interface FleetGroup {
  hostId: string
  hostName: string
  status: Host['status']
  channel: Host['connectionMode']
  /** 该 host 本轮扫描失败（pane 被判 disconnected）：分组头显示断连而不是整面板报错 */
  unreachable: boolean
  rows: FleetRow[]
}

export interface FleetFilters {
  /** 只看需要我处理的（blocked + failed），默认开 */
  needsAttention?: boolean
  /** 只看绑了任务号的 */
  hasTaskOnly?: boolean
  /** host 多选；空/未给 = 全部 */
  hostIds?: string[]
  /** 任务号 / session 名 / agent 名 / host 名，纯前端匹配 */
  query?: string
}

// 状态排序：需要我处理的排最前，同状态内按 since 升序（卡最久的在前）。
// 文档 §3.4 列的是 blocked → failed → working → idle → unknown，没提 done：
// done 是「跑完了等你验收」，比正在跑的更该被看见，所以排在 working 之前、idle 之后
const RANK = { blocked: 1, failed: 2, done: 3, working: 4, idle: 6, unknown: 7 } as const
/** 「需要我处理」的就是 blocked（等我拍板）与 failed（跑挂了）两档 */
export const FLEET_ATTENTION_MAX_RANK = RANK.failed

export function fleetRank(row: Pick<FleetRow, 'status' | 'phase' | 'lastEvent'>) {
  if (row.status === 'blocked') return RANK.blocked
  // 状态还是 working/idle 但最近一次事件是 failed：界面要按 failed 排、按 failed 过滤
  if (row.phase === 'failed' || row.lastEvent === 'failed') return RANK.failed
  return RANK[row.status] ?? RANK.unknown
}

/** 任务号是 tmux user-option 的原文，去掉空白后为空按「没绑」处理，别在表格里留空串 */
export function parseFleetTask(task: string | undefined | null) {
  const value = typeof task === 'string' ? task.trim() : ''
  return value || null
}

// 相对时长只吃时间戳、不碰网络：面板每分钟重算一次（§3.3「停留」列）
export function formatFleetDuration(since: string | null | undefined, now: number) {
  if (!since) return ''
  const started = Date.parse(since)
  if (!Number.isFinite(started)) return ''
  const seconds = Math.max(0, Math.floor((now - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// 任务号与 pane 序号不在 agents 帧里（那一层只有状态）：它们来自
// GET /hosts/:hostId/sessions/:sessionId/panes（冷数据，面板可见时低频刷一次）
function toRow(
  host: Host,
  session: Session,
  pane: AgentPaneState,
  recovery: AgentRecoveryCandidate | undefined,
  paneMeta: Pane | undefined,
): FleetRow {
  const paneId = pane.paneId || pane.tmuxPaneId
  return {
    key: `${host.id}:${paneId}`,
    hostId: host.id,
    hostName: host.name || host.id,
    hostStatus: host.status,
    hostChannel: host.connectionMode,
    sessionName: session.name || pane.sessionName,
    sessionId: session.id,
    paneId,
    tmuxPaneId: pane.tmuxPaneId || '',
    // 序号/任务号取 pane 列表；那一份还没到时显示 —，不猜
    paneIndex: typeof paneMeta?.index === 'number' ? paneMeta.index : null,
    agent: pane.agent || null,
    task: parseFleetTask(paneMeta?.task),
    status: pane.agentStatus || 'unknown',
    phase: pane.phase,
    lastEvent: pane.lastEvent,
    since: pane.since || null,
    updatedAt: pane.updatedAt || null,
    recovery: recovery && recovery.status === 'pending' ? recovery : null,
  }
}

function matchesQuery(row: FleetRow, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [row.task, row.sessionName, row.agent, row.hostName, row.hostId, row.tmuxPaneId]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle))
}

export function buildFleet(options: {
  hosts: Host[]
  /** hostId → 该 host 的 session 列表（含 agents）；缺宿主即视为还没取到 */
  sessionsByHost: Record<string, Session[] | undefined>
  /** hostId → 待恢复候选 */
  recoveryByHost?: Record<string, AgentRecoveryCandidate[] | undefined>
  /** `${hostId}:${sessionId}` → 该 session 的 pane 列表（带 task / index 的冷数据） */
  panesBySession?: Record<string, Pane[] | undefined>
  filters?: FleetFilters
}) {
  const { hosts, sessionsByHost, recoveryByHost = {}, panesBySession = {}, filters = {} } = options
  const hostFilter = filters.hostIds?.length ? new Set(filters.hostIds) : null
  const allRows: FleetRow[] = []
  // 过滤前的 agent 总数：全为 0 说明机器上还没有 agent pane（引导装 hook），
  // 否则空列表只是筛掉了——两种空态文案不同，别混成一个
  let available = 0
  for (const host of hosts) {
    if (hostFilter && !hostFilter.has(host.id)) continue
    const candidates = (recoveryByHost[host.id] || []).filter((item) => item.status === 'pending')
    const byPane = new Map<string, AgentRecoveryCandidate>()
    for (const candidate of candidates) byPane.set(candidate.paneId, candidate)
    for (const session of sessionsByHost[host.id] || []) {
      const paneList = panesBySession[`${host.id}:${session.id}`] || []
      const byId = new Map<string, Pane>()
      for (const item of paneList) {
        byId.set(item.id, item)
        if (item.tmuxPaneId) byId.set(item.tmuxPaneId, item)
      }
      for (const pane of session.agents || []) {
        available += 1
        const row = toRow(
          host,
          session,
          pane,
          byPane.get(pane.paneId) || byPane.get(pane.tmuxPaneId),
          byId.get(pane.paneId) || byId.get(pane.tmuxPaneId),
        )
        if (filters.hasTaskOnly && !row.task) continue
        if (filters.needsAttention && fleetRank(row) > FLEET_ATTENTION_MAX_RANK) continue
        if (!matchesQuery(row, filters.query || '')) continue
        allRows.push(row)
      }
    }
  }
  allRows.sort((left, right) => {
    const rank = fleetRank(left) - fleetRank(right)
    if (rank !== 0) return rank
    // since 升序：起得越早（= 卡得越久）越靠前；缺 since 的排在同档末尾
    const leftSince = left.since ? Date.parse(left.since) : Number.POSITIVE_INFINITY
    const rightSince = right.since ? Date.parse(right.since) : Number.POSITIVE_INFINITY
    if (leftSince !== rightSince) return leftSince - rightSince
    return left.key.localeCompare(right.key)
  })
  const groups: FleetGroup[] = []
  for (const host of hosts) {
    if (hostFilter && !hostFilter.has(host.id)) continue
    const rows = allRows.filter((row) => row.hostId === host.id)
    // 过滤后为空的 host 不出分组：否则「只看需要我处理」时会剩一排空标题
    if (!rows.length) continue
    groups.push({
      hostId: host.id,
      hostName: host.name || host.id,
      status: host.status,
      channel: host.connectionMode,
      unreachable: rows.every((row) => row.phase === 'disconnected'),
      rows,
    })
  }
  return {
    rows: allRows,
    groups,
    /** 过滤前的 agent 总数，用于区分「没有 agent」与「都筛掉了」 */
    available,
    total: allRows.length,
    blocked: allRows.filter((row) => row.status === 'blocked').length,
    withRecovery: allRows.filter((row) => row.recovery).length,
  }
}
