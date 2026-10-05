import os from 'os'
import path from 'path'
import { JsonStore } from './json-store.js'
import { execTmux } from './tmux-executor.js'

// Agent restart recovery manifest：pane 进程退出/gateway 重启后用户可见的
// 可恢复候选。只存元数据——禁存 token/env/pane 输出/完整命令参数；
// 原生 agentSessionId 仅协议明确上报时才存在（scan 合成 id 不算），
// 它是 provider allowlist 拼 resume 命令的唯一输入
export interface AgentRecoveryCandidate {
  id: string
  hostId: string
  sessionName: string
  paneId: string
  tmuxPaneId: string
  agent: string
  agentSessionId?: string
  cwd?: string
  lastSeenAt: string
  reason: string
  status: 'pending' | 'resumed'
  createdAt: string
  resumedAt?: string
}
export interface RecoveryCandidateInput {
  hostId: string
  sessionName: string
  paneId: string
  tmuxPaneId: string
  agent: string
  agentSessionId?: string
  cwd?: string
  lastSeenAt?: string
  reason: string
}
// resume 目标：pane=候选原 pane；active=候选 session 的当前激活 pane
// （用户在 tmux 里新开 pane 聚焦即可换目标，前端无需感知 pane 身份）
export type RecoveryTargetMode = 'pane' | 'active'
export interface RecoveryResumeTarget {
  paneId: string
  agentSessionId: string
  targetMode?: RecoveryTargetMode
}
export type RecoveryPaneState = 'shell' | 'occupied' | 'dead' | 'missing' | 'in_mode' | 'unknown'
export interface RecoveryPaneInspection {
  state: RecoveryPaneState
  command?: string
  cwd?: string
  // session:window.pane 坐标 target——tmux 3.4 对 %0 的 pane-id 目标解析有
  // bug（id 0 被当作未命中→报 no current client），send-keys 必须走坐标
  target?: string
}
export class RecoveryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
export const recoveryCandidateTtlMs = 24 * 60 * 60 * 1000
const recoveryCandidateLimit = 100
const candidateFileVersion = 1
// resume 只往空闲 shell pane 里打字；pane 当前跑着其他进程（含别的 agent）一律拒绝
const shellCommands = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'xonsh', 'login'])
// provider allowlist：仅协议/实现明确的 provider 可拼 resume 命令；
// agentSessionId 走严格白名单字符集，杜绝 shell 注入面。
// byId=按原生 session id 精准恢复；cont=无 id 时续该 pane cwd 的最近一次会话
// （CLI 自带 continue-last 语义），缺 agentSessionId 不再是硬阻断
const resumeArgPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const resumeProviders: Record<string, { byId?: (id: string) => string; cont?: string }> = {
  claude: { byId: (id) => `claude --resume ${id}` },
  codex: { byId: (id) => `codex resume ${id}` },
  'dsh-tui': { byId: (id) => `dsh-tui --resume ${id}`, cont: 'dsh-tui --resume' },
  opencode: { byId: (id) => `opencode --session ${id}`, cont: 'opencode -c' },
  kimi: { byId: (id) => `kimi --session ${id}`, cont: 'kimi -c' },
  // mimo 为 opencode 同系 CLI，旗标已核实（-c/--session）
  mimo: { byId: (id) => `mimo --session ${id}`, cont: 'mimo -c' },
}
function getRecoveryPath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'agent-recovery.json')
}
function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function sanitizeReason(value: unknown) {
  return text(value, 64) || 'pane_exited'
}
function isCandidate(value: unknown): value is AgentRecoveryCandidate {
  const candidate = value as AgentRecoveryCandidate
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    typeof candidate.id === 'string' &&
    typeof candidate.hostId === 'string' &&
    typeof candidate.sessionName === 'string' &&
    typeof candidate.paneId === 'string' &&
    typeof candidate.tmuxPaneId === 'string' &&
    typeof candidate.agent === 'string' &&
    typeof candidate.lastSeenAt === 'string' &&
    (candidate.status === 'pending' || candidate.status === 'resumed')
  )
}
// 持久化走 JsonStore：0600/原子 temp+rename/.bak 回退/进程内串行 update。
// store 按 manifest 路径缓存——队列必须按文件共享才有互斥语义
const recoveryStores = new Map<string, JsonStore<AgentRecoveryCandidate>>()
function getRecoveryStore(recoveryPath: string) {
  let store = recoveryStores.get(recoveryPath)
  if (!store) {
    store = new JsonStore<AgentRecoveryCandidate>(recoveryPath, {
      key: 'candidates',
      expectedVersion: candidateFileVersion,
      normalize: (input) => {
        const cutoff = Date.now() - recoveryCandidateTtlMs
        return (Array.isArray(input) ? input : [])
          .filter(isCandidate)
          .filter((candidate) => Date.parse(candidate.lastSeenAt) > cutoff)
          .slice(0, recoveryCandidateLimit)
      },
    })
    recoveryStores.set(recoveryPath, store)
  }
  return store
}
function readCandidates(recoveryPath = getRecoveryPath()) {
  return getRecoveryStore(recoveryPath).read()
}
function candidateKey(candidate: Pick<AgentRecoveryCandidate, 'hostId' | 'paneId' | 'agentSessionId'>) {
  return `${candidate.hostId}|${candidate.paneId}|${candidate.agentSessionId || ''}`
}
export async function upsertRecoveryCandidate(input: RecoveryCandidateInput, recoveryPath = getRecoveryPath()) {
  const candidate: AgentRecoveryCandidate = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    hostId: text(input.hostId, 128),
    sessionName: text(input.sessionName, 256),
    paneId: text(input.paneId, 256),
    tmuxPaneId: text(input.tmuxPaneId, 64),
    agent: text(input.agent, 64),
    agentSessionId: text(input.agentSessionId, 256) || undefined,
    cwd: text(input.cwd, 1024) || undefined,
    lastSeenAt: input.lastSeenAt || new Date().toISOString(),
    reason: sanitizeReason(input.reason),
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  if (!candidate.hostId || !candidate.paneId || !candidate.tmuxPaneId || !candidate.agent) return null
  return getRecoveryStore(recoveryPath).update((candidates) => {
    const existing = candidates.find((item) => candidateKey(item) === candidateKey(candidate))
    if (existing) {
      // 同 pane/agentSessionId 去重：会话再次退出时刷新元数据并回到待确认
      existing.sessionName = candidate.sessionName || existing.sessionName
      existing.agent = candidate.agent || existing.agent
      existing.cwd = candidate.cwd || existing.cwd
      existing.lastSeenAt = candidate.lastSeenAt
      existing.reason = candidate.reason
      existing.status = 'pending'
      existing.resumedAt = undefined
      return { items: candidates, result: existing }
    }
    return { items: [candidate, ...candidates].slice(0, recoveryCandidateLimit), result: candidate }
  })
}
export async function listRecoveryCandidates(hostId: string, options: { includeResumed?: boolean } = {}) {
  return (await readCandidates())
    .filter((candidate) => candidate.hostId === hostId && (options.includeResumed || candidate.status === 'pending'))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
}
export async function getRecoveryCandidate(hostId: string, candidateId: string) {
  return (await listRecoveryCandidates(hostId, { includeResumed: true })).find(
    (candidate) => candidate.id === candidateId,
  )
}
export async function markRecoveryCandidateResumed(hostId: string, candidateId: string) {
  return getRecoveryStore(getRecoveryPath()).update((candidates) => {
    const candidate = candidates.find((item) => item.hostId === hostId && item.id === candidateId)
    if (!candidate) return { items: candidates, result: null }
    candidate.status = 'resumed'
    candidate.resumedAt = new Date().toISOString()
    return { items: candidates, result: candidate }
  })
}
export function buildResumeCommand(agent: string, agentSessionId: string | undefined) {
  const provider = resumeProviders[agent]
  if (!provider) return null
  // 有合法原生 id 优先 byId 精准恢复；否则退化 cont 续最近会话
  if (agentSessionId && resumeArgPattern.test(agentSessionId) && provider.byId) return provider.byId(agentSessionId)
  return provider.cont || null
}
// 尾部 pane_active/window_active 供 active 模式定位「session 当前激活 pane」
const paneInspectFormat =
  '#{pane_id}\t#{pane_current_command}\t#{pane_dead}\t#{pane_current_path}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_in_mode}\t#{pane_active}\t#{window_active}'
function inspectPaneRow(row: string[] | undefined): RecoveryPaneInspection {
  if (!row) return { state: 'missing' }
  const [, command, dead, cwd, session, windowIndex, paneIndex, inMode] = row
  const target = session && windowIndex && paneIndex ? `${session}:${windowIndex}.${paneIndex}` : undefined
  if (dead === '1') return { state: 'dead', command, cwd, target }
  // copy/view 等 mode 会拦截 send-keys（输入进 mode 而非 tty）——shell 在 mode
  // 里同样不可恢复，单列状态让提示和拦截都明确
  if (inMode === '1') return { state: 'in_mode', command, cwd, target }
  const base = (command || '').trim().toLowerCase().split(/[\\/]/).pop() || ''
  return shellCommands.has(base)
    ? { state: 'shell', command, cwd, target }
    : { state: 'occupied', command, cwd, target }
}
// 一次 list-panes 探测整台 host 的 pane 占用；exec 失败返回 null（=unknown），
// 由调用方决定「未知」语义——列表宽松放行、resume 严格拦截
export async function inspectRecoveryPanes(hostId: string) {
  try {
    const { stdout } = await execTmux(hostId, ['list-panes', '-a', '-F', paneInspectFormat], { timeoutMs: 8000 })
    const rows = new Map(
      stdout
        .trim()
        .split('\n')
        .map((line) => line.split('\t'))
        .map((row) => [row[0], row] as const),
    )
    return rows
  } catch {
    return null
  }
}
export async function inspectRecoveryPane(hostId: string, tmuxPaneId: string): Promise<RecoveryPaneInspection> {
  const rows = await inspectRecoveryPanes(hostId)
  if (!rows) return { state: 'unknown' }
  return inspectPaneRow(rows.get(tmuxPaneId))
}
export function inspectPaneRowFromList(rows: Map<string, string[]> | null, tmuxPaneId: string) {
  if (!rows) return { state: 'unknown' as const }
  return inspectPaneRow(rows.get(tmuxPaneId))
}
// session 当前激活 pane = 激活窗口里的激活 pane；找不到返回 undefined
export function findSessionActivePaneRow(rows: Map<string, string[]> | null, sessionName: string) {
  if (!rows) return undefined
  for (const row of rows.values()) {
    if (row[4] === sessionName && row[8] === '1' && row[9] === '1') return row
  }
  return undefined
}
export function describeRecoveryCandidate(candidate: AgentRecoveryCandidate, inspection?: RecoveryPaneInspection) {
  const state = inspection?.state || 'unknown'
  if (state !== 'shell' && state !== 'unknown')
    return { resumable: false, blockReason: `pane_${state}` as const, occupant: state }
  if (!resumeProviders[candidate.agent])
    return { resumable: false, blockReason: 'provider_not_supported' as const, occupant: state }
  // cont 型 provider 无 id 也可续最近会话；只缺 byId 且没 cont 时才因 id 受阻
  if (!buildResumeCommand(candidate.agent, candidate.agentSessionId))
    return {
      resumable: false,
      blockReason: (candidate.agentSessionId ? 'invalid_session_id' : 'missing_session_id') as const,
      occupant: state,
    }
  return { resumable: state === 'shell', blockReason: state === 'shell' ? undefined : 'pane_unknown', occupant: state }
}
// 显式 resume：逐级校验，任一步失败抛带 code 的可解释错误；通过后只把
// provider allowlist 拼出的固定命令 send-keys 进 pane（用户在终端里可见）
export async function resumeRecoveryCandidate(hostId: string, candidateId: string, target: RecoveryResumeTarget) {
  const candidate = await getRecoveryCandidate(hostId, candidateId)
  if (!candidate) throw new RecoveryError('candidate_not_found', 'Recovery candidate not found or expired')
  if (candidate.status !== 'pending') throw new RecoveryError('already_resumed', 'Recovery candidate already resumed')
  if (!resumeProviders[candidate.agent])
    throw new RecoveryError('provider_not_supported', `Provider "${candidate.agent}" does not support resume`)
  const command = buildResumeCommand(candidate.agent, candidate.agentSessionId)
  if (!command)
    throw new RecoveryError(
      candidate.agentSessionId ? 'invalid_session_id' : 'missing_session_id',
      'Agent session id is not a safe resume argument and provider has no continue fallback',
    )
  // 客户端回传的 '' 等价于未携带 id（cont 型 provider 允许无 id 候选）
  const sentId = target.agentSessionId || undefined
  if (target.paneId !== candidate.paneId || sentId !== candidate.agentSessionId)
    throw new RecoveryError('target_mismatch', 'Resume target does not match the recovery candidate')
  const rows = await inspectRecoveryPanes(hostId)
  // active 模式：原 pane 可能已死/被占，目标改为候选 session 的当前激活 pane；
  // 目标限定在同一 session 内，路由侧 session scope 校验天然覆盖
  const targetRow =
    target.targetMode === 'active'
      ? findSessionActivePaneRow(rows, candidate.sessionName)
      : rows?.get(candidate.tmuxPaneId)
  const inspection = inspectPaneRow(targetRow)
  if (inspection.state === 'missing') throw new RecoveryError('pane_missing', 'Target pane no longer exists')
  if (inspection.state === 'dead') throw new RecoveryError('pane_dead', 'Target pane is dead')
  if (inspection.state === 'in_mode')
    throw new RecoveryError('pane_in_mode', 'Target pane is in a tmux mode; exit the mode before resuming')
  if (inspection.state !== 'shell')
    throw new RecoveryError('pane_occupied', `Target pane is occupied by ${inspection.command || 'another process'}`)
  const sendTarget = inspection.target || candidate.sessionName
  const targetTmuxPaneId = targetRow?.[0] || candidate.tmuxPaneId
  try {
    // %0 触发 tmux 3.4 pane-id 解析 bug，统一发坐标 target（session:win.pane）；
    // 文本走 -l 字面模式再单独发 Enter——不分两段时 tmux 会把整串当 key name
    // 逐个解析，空格/-- 段在无 client 的 server 上报 no current client
    await execTmux(hostId, ['send-keys', '-l', '-t', sendTarget, command], { timeoutMs: 8000 })
    await execTmux(hostId, ['send-keys', '-t', sendTarget, 'Enter'], { timeoutMs: 8000 })
  } catch (error) {
    throw new RecoveryError(
      'send_failed',
      `Failed to send resume command: ${error instanceof Error ? error.message : error}`,
    )
  }
  await markRecoveryCandidateResumed(hostId, candidateId)
  return { ok: true as const, paneId: candidate.paneId, tmuxPaneId: targetTmuxPaneId, command }
}
