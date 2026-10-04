import { randomUUID } from 'crypto'
import { inspectPaneRowFromList, inspectRecoveryPanes } from './agent-recovery.js'
import { getHostAgentPanes, type AgentPaneState } from './agent-state.js'
import { execTmux } from './tmux-executor.js'

// agent.start / agent.prompt / agent.cancel 的实现层。
// 安全边界（与派工单红线一致）：
// - provider 走 startProviders allowlist，启动命令只能由 provider + actionArgPattern
//   校验过的单 token 参数组装——send-keys -l 字面量入 pane，无任意 shell 拼接面
// - start 只允许落在存活 idle shell pane（复用 recovery 的五态探测，含 in_mode 拦截）
// - prompt 只允许落在 scan 确认占用为 agent 的 pane
// - ack/cancel/quota 全部是进程内存式语义（单进程部署，与派工单一致）

export type AgentActionCode =
  | 'PANE_MISSING'
  | 'PANE_DEAD'
  | 'PANE_IN_MODE'
  | 'PANE_OCCUPIED'
  | 'PANE_NOT_AGENT'
  | 'PANE_UNKNOWN'
  | 'PROVIDER_NOT_SUPPORTED'
  | 'INVALID_ARGUMENT'
  | 'ACK_TIMEOUT'
  | 'OPERATION_CANCELLED'

export class AgentActionError extends Error {
  readonly code: AgentActionCode | 'AGENT_CONTROL_QUOTA_EXCEEDED' | 'AGENT_CONTROL_SEND_FAILED'
  constructor(code: AgentActionError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'AgentActionError'
  }
}

// 启动 provider allowlist：只放行实现明确的 provider；
// 参数逐 token 校验（无空格/无 shell 元字符），杜绝命令注入
export const startProviders = ['claude', 'codex'] as const
export type AgentStartProvider = (typeof startProviders)[number]
export const actionArgPattern = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._:/=-]{0,126}$/
const MAX_START_ARGS = 8
export const maxPromptBytes = 8192
export const maxAckTimeoutMs = 30000
// 每 host 在途 start/prompt 上界：ack 等待最长挂 30s，配额防止控制面被慢确认堆积打满
export const maxPendingOpsPerHost = 8

export function buildAgentStartCommand(provider: string, args: string[] = []) {
  if (!startProviders.includes(provider as AgentStartProvider))
    throw new AgentActionError('PROVIDER_NOT_SUPPORTED', `Provider "${provider}" is not supported`)
  if (args.length > MAX_START_ARGS)
    throw new AgentActionError('INVALID_ARGUMENT', `args supports at most ${MAX_START_ARGS} items`)
  for (const arg of args)
    if (!actionArgPattern.test(arg))
      throw new AgentActionError('INVALID_ARGUMENT', `Unsafe agent argument: ${arg.slice(0, 64)}`)
  return [provider, ...args].join(' ')
}
export function validateAgentPrompt(prompt: string) {
  if (typeof prompt !== 'string' || !prompt.length) throw new AgentActionError('INVALID_ARGUMENT', 'prompt is required')
  if (Buffer.byteLength(prompt, 'utf8') > maxPromptBytes)
    throw new AgentActionError('INVALID_ARGUMENT', `prompt exceeds ${maxPromptBytes} bytes`)
  // NUL/控制字符进 send-keys 会破坏输入流；\n \t 保留（多行输入合法）
  // eslint-disable-next-line no-control-regex -- 这里正是要拒绝控制字符
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt))
    throw new AgentActionError('INVALID_ARGUMENT', 'prompt contains disallowed control characters')
}

// ── 在途 op 注册表 + 配额 ─────────────────────────────────────────────
interface PendingOp {
  opId: string
  hostId: string
  action: 'start' | 'prompt'
  // ack 等待中的 reject 钩子；无 ack 的 op 发送完成即 settle
  cancel: ((error: Error) => void) | null
  settled: boolean
}
const pendingOps = new Map<string, PendingOp>()
const pendingByHost = new Map<string, number>()
// 已结算 opId 墓碑（有界 FIFO）：cancel 据此区分 already_settled / not_found
const settledOpIds = new Set<string>()
function markSettledOpId(opId: string) {
  settledOpIds.add(opId)
  if (settledOpIds.size > 512) settledOpIds.delete(settledOpIds.values().next().value!)
}

const opIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
function acquireOp(hostId: string, action: PendingOp['action'], requestedId?: string) {
  const count = pendingByHost.get(hostId) || 0
  if (count >= maxPendingOpsPerHost)
    throw new AgentActionError(
      'AGENT_CONTROL_QUOTA_EXCEEDED',
      `Too many in-flight agent operations on host "${hostId}" (max ${maxPendingOpsPerHost})`,
    )
  // 客户端可自带 opId（幂等键）：ack 等待中的请求未返回时也能精确 cancel。
  // 与在途/已结算 id 冲突一律拒绝，避免 cancel 歧义
  if (requestedId !== undefined) {
    if (!opIdPattern.test(requestedId)) throw new AgentActionError('INVALID_ARGUMENT', 'Invalid opId')
    if (pendingOps.has(requestedId) || settledOpIds.has(requestedId))
      throw new AgentActionError('INVALID_ARGUMENT', `Duplicate opId "${requestedId}"`)
  }
  const op: PendingOp = { opId: requestedId || randomUUID(), hostId, action, cancel: null, settled: false }
  pendingOps.set(op.opId, op)
  pendingByHost.set(hostId, count + 1)
  return op
}
function settleOp(op: PendingOp) {
  if (op.settled) return
  op.settled = true
  pendingOps.delete(op.opId)
  pendingByHost.set(op.hostId, Math.max(0, (pendingByHost.get(op.hostId) || 1) - 1))
  markSettledOpId(op.opId)
}
export type AgentCancelState = 'cancelled' | 'not_found' | 'already_settled'
export function cancelAgentOperation(opId: string): { state: AgentCancelState } {
  const op = pendingOps.get(opId)
  if (!op) return { state: settledOpIds.has(opId) ? 'already_settled' : 'not_found' } // 幂等：重复/未知 cancel 不报错
  if (op.settled) return { state: 'already_settled' }
  op.settled = true // 先占位防重入，再 reject 让等待方以 OPERATION_CANCELLED 失败
  pendingOps.delete(opId)
  pendingByHost.set(op.hostId, Math.max(0, (pendingByHost.get(op.hostId) || 1) - 1))
  markSettledOpId(opId)
  op.cancel?.(new AgentActionError('OPERATION_CANCELLED', `Operation ${opId} was cancelled`))
  return { state: 'cancelled' }
}
export function pendingAgentOpCount(hostId?: string) {
  return hostId ? pendingByHost.get(hostId) || 0 : pendingOps.size
}
// 测试用：清掉残留 op
export function _resetAgentOpsForTest() {
  pendingOps.clear()
  pendingByHost.clear()
  settledOpIds.clear()
}

// ── 可注入依赖（单测替身；默认走真实链路）─────────────────────────────
export interface AgentActionDeps {
  exec: typeof execTmux
  inspect: typeof inspectRecoveryPanes
  scanAgents: (hostId: string) => Promise<AgentPaneState[]>
  sleep: (ms: number) => Promise<void>
  now: () => number
}
const defaultDeps: AgentActionDeps = {
  exec: execTmux,
  inspect: inspectRecoveryPanes,
  scanAgents: (hostId) => getHostAgentPanes(hostId),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}
function deps(overrides: Partial<AgentActionDeps> = {}) {
  return { ...defaultDeps, ...overrides }
}

async function sendKeysLiteral(hostId: string, target: string, text: string, exec: typeof execTmux) {
  try {
    // 与 recovery resume 同一套路：文本 -l 字面量、Enter 单独发；
    // target 用 session:win.pane 坐标（tmux 3.4 对 %0 pane-id 有解析 bug）
    await exec(hostId, ['send-keys', '-l', '-t', target, text], { timeoutMs: 8000 })
    await exec(hostId, ['send-keys', '-t', target, 'Enter'], { timeoutMs: 8000 })
  } catch (error) {
    throw new AgentActionError(
      'AGENT_CONTROL_SEND_FAILED',
      `send-keys failed: ${error instanceof Error ? error.message : error}`,
    )
  }
}
function assertPaneState(
  inspection: { state: string; command?: string; target?: string },
  allowed: 'shell' | 'occupied',
) {
  if (inspection.state === 'missing') throw new AgentActionError('PANE_MISSING', 'Target pane no longer exists')
  if (inspection.state === 'dead') throw new AgentActionError('PANE_DEAD', 'Target pane is dead')
  if (inspection.state === 'in_mode') throw new AgentActionError('PANE_IN_MODE', 'Target pane is in a tmux mode')
  if (inspection.state === 'unknown')
    throw new AgentActionError('PANE_UNKNOWN', 'Target pane state is unknown (host unreachable)')
  if (allowed === 'shell' && inspection.state !== 'shell')
    throw new AgentActionError('PANE_OCCUPIED', `Target pane is occupied by ${inspection.command || 'another process'}`)
  if (allowed === 'occupied' && inspection.state !== 'occupied')
    throw new AgentActionError('PANE_NOT_AGENT', 'Target pane is not occupied by an agent')
}

function findAgentPane(states: AgentPaneState[], hostId: string, tmuxPaneId: string) {
  return states.find(
    (item) => (item.tmuxPaneId === tmuxPaneId || item.paneId === `${hostId}:${tmuxPaneId}`) && item.agent,
  )
}

// ack：op 保持 pending，轮询 agent scan 直到谓词满足/超时/cancel。
// 不用 agentControl.wait：scan 链路对「首次出现的 agent」不产 lastEvent=started
// （transition 只在已记录 phase→working 迁移时发），started 语义=出现在 agent
// 列表；轮询 scan 也不引入 monitor 常驻副作用
const ACK_POLL_MS = 250
async function waitForAck(
  op: PendingOp,
  d: AgentActionDeps,
  tmuxPaneId: string,
  timeoutMs: number,
  predicate: (pane: AgentPaneState | undefined) => boolean,
) {
  const deadline = d.now() + timeoutMs
  let pane: AgentPaneState | undefined
  const settled = new Promise<never>((_, reject) => (op.cancel = reject))
  const poll = (async () => {
    for (;;) {
      pane = findAgentPane(await d.scanAgents(op.hostId).catch(() => [] as AgentPaneState[]), op.hostId, tmuxPaneId)
      if (predicate(pane)) return pane!
      if (d.now() >= deadline)
        throw new AgentActionError('ACK_TIMEOUT', `Agent acknowledgement timed out after ${timeoutMs}ms`)
      await d.sleep(ACK_POLL_MS)
    }
  })()
  return Promise.race([poll, settled])
}

export interface AgentStartInput {
  provider: string
  args?: string[]
  ackTimeoutMs?: number
  opId?: string
}
export async function startAgentInPane(
  hostId: string,
  tmuxPaneId: string,
  input: AgentStartInput,
  overrides: Partial<AgentActionDeps> = {},
) {
  const d = deps(overrides)
  const command = buildAgentStartCommand(input.provider, input.args)
  const inspection = inspectPaneRowFromList(await d.inspect(hostId), tmuxPaneId)
  assertPaneState(inspection, 'shell')
  const op = acquireOp(hostId, 'start', input.opId)
  try {
    await sendKeysLiteral(hostId, inspection.target || tmuxPaneId, command, d.exec)
    if (!input.ackTimeoutMs) return { opId: op.opId, acked: false as const }
    // started 语义 = pane 进入 agent 列表（首现即 started；见 waitForAck 注释）
    const pane = await waitForAck(op, d, tmuxPaneId, input.ackTimeoutMs, (pane) => !!pane)
    return { opId: op.opId, acked: true as const, pane }
  } finally {
    settleOp(op)
  }
}

export interface AgentPromptInput {
  prompt: string
  ackTimeoutMs?: number
  opId?: string
}
export async function promptAgentInPane(
  hostId: string,
  tmuxPaneId: string,
  input: AgentPromptInput,
  overrides: Partial<AgentActionDeps> = {},
) {
  const d = deps(overrides)
  validateAgentPrompt(input.prompt)
  const inspection = inspectPaneRowFromList(await d.inspect(hostId), tmuxPaneId)
  assertPaneState(inspection, 'occupied')
  // occupied 不等于 agent 占用：scan 再确认 pane 登记为 agent（command 启发式）
  const agentPanes = await d.scanAgents(hostId).catch(() => [] as AgentPaneState[])
  const pane = findAgentPane(agentPanes, hostId, tmuxPaneId)
  if (!pane?.agent) throw new AgentActionError('PANE_NOT_AGENT', 'Target pane is not occupied by an agent')
  // prompt ack 基线：发送前的 stateSeq/revision；ack = 状态变化或进入 working
  const baselineSeq = pane.stateSeq ?? pane.revision
  const op = acquireOp(hostId, 'prompt', input.opId)
  try {
    await sendKeysLiteral(hostId, inspection.target || tmuxPaneId, input.prompt, d.exec)
    if (!input.ackTimeoutMs) return { opId: op.opId, acked: false as const }
    const acked = await waitForAck(
      op,
      d,
      tmuxPaneId,
      input.ackTimeoutMs,
      (next) => !!next && (next.agentStatus === 'working' || (next.stateSeq ?? next.revision) !== baselineSeq),
    )
    return { opId: op.opId, acked: true as const, pane: acked }
  } finally {
    settleOp(op)
  }
}
