import { randomUUID } from 'crypto'
import { agentMonitor, type AgentMonitorEvent } from './agent-monitor.js'
import { inspectRecoveryPane, type RecoveryPaneInspection } from './agent-recovery.js'
import { getHostAgentPanes, type AgentPaneState } from './agent-state.js'
import { execTmux } from './tmux-executor.js'

export type AgentWaitTarget = { paneId: string } | { sessionName: string; agent: string }
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
  readonly code:
    | 'OCCUPANT_CHANGED'
    | 'PANE_REMOVED'
    | 'TIMEOUT'
    | 'INVALID_TARGET'
    | 'PANE_MISSING'
    | 'PANE_DEAD'
    | 'PANE_IN_MODE'
    | 'PANE_OCCUPIED'
    | 'INVALID_INPUT'
    | 'INVALID_PATTERN'
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
  baselineSeq: number
  startedAt: number
  resolve: (value: AgentWaitResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
function parsePaneId(paneId: string) {
  const separator = paneId.indexOf(':')
  if (separator <= 0 || separator === paneId.length - 1 || !paneId.slice(separator + 1).startsWith('%'))
    throw new AgentWaitError('INVALID_TARGET', 'Invalid pane id')
  return { hostId: paneId.slice(0, separator), tmuxPaneId: paneId.slice(separator + 1) }
}
export function resolveAgentWaitTarget(target: AgentWaitTarget, defaultHostId = 'local') {
  if ('paneId' in target) {
    const { hostId, tmuxPaneId } = parsePaneId(target.paneId)
    return { hostId, tmuxPaneId }
  }
  if (!target.sessionName || !target.agent)
    throw new AgentWaitError('INVALID_TARGET', 'Wait target requires sessionName and agent')
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
  async wait(
    target: AgentWaitTarget,
    condition: AgentWaitCondition,
    options: AgentWaitOptions = {},
  ): Promise<AgentWaitResult> {
    if (!hasCondition(condition))
      throw new AgentWaitError('INVALID_TARGET', 'Wait condition requires status, phase, or lastEvent')
    const { hostId } = resolveAgentWaitTarget(target, options.hostId || 'local')
    if (!hostId) throw new AgentWaitError('INVALID_TARGET', 'Wait target is invalid')
    const startedAt = this.now()
    const timeoutMs = Math.max(250, Math.min(options.timeoutMs || 60000, 600000))
    const waitId = randomUUID()
    const states = this.getStates(hostId) || (await this.scanStates(hostId).catch(() => []))
    const initial = findMatchingPane(states, target)
    if (initial && matchesCondition(initial, condition)) return { pane: initial, elapsedMs: 0, waitId }
    // stateSeq 基线：wait 建立前已物化的状态（含订阅即回放的首个快照、排队旧事件）
    // 不得再次满足条件；无 stateSeq 的旧链路 pane 不受影响
    const baselineSeq = (states || []).reduce((max, pane) => Math.max(max, pane.stateSeq ?? -1), -1)
    const pinned: PinnedOccupant | null = initial
      ? { agent: initial.agent, agentSessionId: initial.agentSessionId, paneId: initial.paneId }
      : null
    return new Promise<AgentWaitResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.waits.get(waitId)
        if (!pending) return
        this.waits.delete(waitId)
        this.ensureUnsubscribed()
        reject(new AgentWaitError('TIMEOUT', `Agent wait timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waits.set(waitId, {
        waitId,
        hostId,
        target,
        condition,
        pinned,
        baselineSeq,
        startedAt,
        resolve,
        reject,
        timer,
      })
      this.ensureSubscribed()
    })
  }
  private handleEvent(event: AgentMonitorEvent) {
    if (event.type === 'agent_status_changed' || event.type === 'agent_status_snapshot') {
      for (const pane of event.type === 'agent_status_snapshot' ? event.agents : [event.pane])
        this.evaluatePane(event.hostId, pane)
    }
    if (event.type === 'agent_status_removed') {
      for (const pending of [...this.waits.values()]) {
        if (pending.hostId !== event.hostId) continue
        if ('paneId' in pending.target && pending.target.paneId === event.paneId)
          this.failWait(pending, new AgentWaitError('PANE_REMOVED', `Target pane ${event.paneId} was removed`))
        else if (!('paneId' in pending.target) && pending.pinned?.paneId === event.paneId)
          this.failWait(pending, new AgentWaitError('PANE_REMOVED', `Target pane ${event.paneId} was removed`))
      }
    }
  }
  private evaluatePane(hostId: string, pane: AgentPaneState) {
    for (const pending of [...this.waits.values()]) {
      if (pending.hostId !== hostId || !matchesSession(pane, pending.target)) continue
      // wait 建立前已存在的旧状态回放：既不满足条件也不参与 occupant 判定
      if (pane.stateSeq !== undefined && pane.stateSeq <= pending.baselineSeq) continue
      if (!pending.pinned) {
        if ('paneId' in pending.target)
          pending.pinned = { agent: pane.agent, agentSessionId: pane.agentSessionId, paneId: pane.paneId }
        else if (pane.agent === pending.target.agent)
          pending.pinned = { agent: pane.agent, agentSessionId: pane.agentSessionId, paneId: pane.paneId }
        else {
          this.failWait(
            pending,
            new AgentWaitError(
              'OCCUPANT_CHANGED',
              `Session ${pane.sessionName} is occupied by ${pane.agent} instead of ${pending.target.agent}`,
            ),
          )
          continue
        }
      }
      if (pending.pinned.paneId && pending.pinned.paneId !== pane.paneId) continue
      const occupantChanged =
        (pending.pinned.agent !== undefined && pane.agent !== pending.pinned.agent) ||
        (pending.pinned.agentSessionId !== undefined && pane.agentSessionId !== pending.pinned.agentSessionId)
      if (occupantChanged) {
        this.failWait(
          pending,
          new AgentWaitError(
            'OCCUPANT_CHANGED',
            `Pane occupant changed from ${pending.pinned.agent || 'unknown'} to ${pane.agent || 'unknown'} before wait condition was met`,
          ),
        )
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
export async function splitAgentPane(
  hostId: string,
  tmuxPaneId: string,
  direction: 'horizontal' | 'vertical',
  cwd?: string,
) {
  const listPanes = async () =>
    (await execTmux(hostId, ['list-panes', '-s', '-t', tmuxPaneId, '-F', '#{pane_id}'])).stdout
      .trim()
      .split('\n')
      .filter(Boolean)
  const before = new Set(await listPanes())
  const args = ['split-window']
  if (cwd && cwd.trim() && /^[A-Za-z0-9_./~-]+$/.test(cwd.trim())) args.push('-c', cwd.trim())
  args.push('-e', 'TMUXGO_ENV=1', '-t', tmuxPaneId, direction === 'horizontal' ? '-h' : '-v')
  await execTmux(hostId, args)
  const after = await listPanes()
  return after.find((paneId) => !before.has(paneId)) || after[after.length - 1] || ''
}
export async function readAgentPane(hostId: string, tmuxPaneId: string, lines = 200) {
  const count = Math.max(1, Math.min(Math.floor(lines), 2000))
  const { stdout } = await execTmux(hostId, ['capture-pane', '-e', '-p', '-t', tmuxPaneId, '-S', `-${count}`])
  return stdout
}

// ---- Task9 编排原语：snapshot / wait-output / run ----
// 统一约定：exec/inspect 可注入（单测不触真实 tmux）；所有 tmux 调用走
// argv 数组，gateway 侧零 shell 拼接；返回字段全部定长截断。

type TmuxExecFn = (hostId: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string }>
type PaneInspectFn = (hostId: string, tmuxPaneId: string) => Promise<RecoveryPaneInspection>

const paneFieldCap = 512
const snapshotTailLineCap = 200
const snapshotTailTotalCap = 8192

// 单行化 + 定长：pane_title 等字段可含换行/超长内容，响应必须保持有界且可预测
function capField(value: string | undefined, max = paneFieldCap) {
  return (value || '').split('\n')[0].slice(0, max)
}
function capTail(raw: string, maxLines: number) {
  const lines = raw.replace(/\n+$/, '').split('\n')
  const tail = lines.slice(-maxLines).map((line) => line.slice(0, snapshotTailLineCap))
  // 总量二次封顶：超长行集仍可能撑爆单条响应——从最旧行开始丢，至少留 1 行
  let total = tail.join('\n').length
  while (tail.length > 1 && total > snapshotTailTotalCap) total -= tail.shift()!.length + 1
  return tail.filter((line) => line.length > 0)
}

const snapshotFormat =
  '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}\t#{pane_dead}\t#{pane_in_mode}\t#{pane_width}\t#{pane_height}\t#{pane_active}'
export interface AgentPaneSnapshot {
  paneId: string
  tmuxPaneId: string
  sessionName: string
  windowIndex: string
  paneIndex: string
  command: string
  title: string
  cwd: string
  dead: boolean
  inMode: boolean
  active: boolean
  size: { cols: number; rows: number }
  tail: string[]
}
// display-message 一次取齐结构字段 + capture-pane 取有界 tail。
// 绝不返回 env/token/无界历史（capture 只取最后 N 行）
export async function snapshotAgentPane(
  hostId: string,
  tmuxPaneId: string,
  lines = 12,
  exec: TmuxExecFn = (h, a, o) => execTmux(h, a, o).then((r) => ({ stdout: r.stdout })),
): Promise<AgentPaneSnapshot> {
  let row: string[]
  try {
    const { stdout } = await exec(hostId, ['display-message', '-p', '-t', tmuxPaneId, '-F', snapshotFormat], {
      timeoutMs: 8000,
    })
    row = stdout.replace(/\n+$/, '').split('\t')
  } catch {
    throw new AgentWaitError('PANE_MISSING', `Pane ${tmuxPaneId} does not exist`)
  }
  const count = Math.max(1, Math.min(Math.floor(lines), 100))
  const { stdout: capture } = await exec(hostId, ['capture-pane', '-p', '-t', tmuxPaneId, '-S', `-${count}`], {
    timeoutMs: 8000,
  })
  return {
    paneId: `${hostId}:${capField(row[0], 64)}`,
    tmuxPaneId: capField(row[0], 64),
    sessionName: capField(row[1], 64),
    windowIndex: capField(row[2], 16),
    paneIndex: capField(row[3], 16),
    command: capField(row[4], 120),
    title: capField(row[5], 160),
    cwd: capField(row[6]),
    dead: row[7] === '1',
    inMode: row[8] === '1',
    active: row[11] === '1',
    size: { cols: Number(row[9]) || 0, rows: Number(row[10]) || 0 },
    tail: capTail(capture, count),
  }
}

const waitOutputOccupantFormat = '#{pane_current_command}\t#{pane_dead}'
export interface WaitAgentPaneOutputOptions {
  match?: string
  regex?: boolean
  lines?: number
  timeoutMs?: number
  pollMs?: number
  exec?: TmuxExecFn
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}
export interface WaitAgentPaneOutputResult {
  matched: boolean
  changed: boolean
  waitId: string
  elapsedMs: number
  output: string
}
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function buildOutputMatcher(match: string | undefined, regex: boolean) {
  if (!match) return null
  if (!regex) return (tail: string) => tail.includes(match)
  let compiled: RegExp
  try {
    compiled = new RegExp(match)
  } catch {
    throw new AgentWaitError('INVALID_PATTERN', 'wait-output match is not a valid regular expression')
  }
  return (tail: string) => compiled.test(tail)
}
// 服务端持有轮询：tail 窗口有界（≤200 行）、poll 间隔固定、timeout 必有上限。
// pane 消失 → PANE_REMOVED；occupant（pane_current_command）变更/dead → OCCUPANT_CHANGED，
// 替代进程不得满足等待；match 判定先于 occupant 判定，先到的匹配仍算成功。
export async function waitAgentPaneOutput(
  hostId: string,
  tmuxPaneId: string,
  options: WaitAgentPaneOutputOptions = {},
): Promise<WaitAgentPaneOutputResult> {
  const exec = options.exec || ((h, a, o) => execTmux(h, a, o).then((r) => ({ stdout: r.stdout })))
  const sleep = options.sleep || defaultSleep
  const now = options.now || (() => Date.now())
  const matcher = buildOutputMatcher(options.match, options.regex === true)
  const count = Math.max(1, Math.min(Math.floor(options.lines || 50), 200))
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs || 60000, 600000))
  const pollMs = Math.max(50, Math.min(options.pollMs || 300, 5000))
  const waitId = randomUUID()
  const startedAt = now()
  const readTail = () =>
    exec(hostId, ['capture-pane', '-p', '-t', tmuxPaneId, '-S', `-${count}`], { timeoutMs: 8000 }).then((r) => r.stdout)
  const readOccupant = async () => {
    const { stdout } = await exec(hostId, ['display-message', '-p', '-t', tmuxPaneId, '-F', waitOutputOccupantFormat], {
      timeoutMs: 8000,
    })
    const [command, dead] = stdout.replace(/\n+$/, '').split('\t')
    return { command: command || '', dead: dead === '1' }
  }
  let baseline: { command: string; dead: boolean }
  let baselineTail: string
  try {
    baseline = await readOccupant()
    baselineTail = await readTail()
  } catch {
    throw new AgentWaitError('PANE_MISSING', `Pane ${tmuxPaneId} does not exist`)
  }
  if (baseline.dead) throw new AgentWaitError('PANE_DEAD', `Pane ${tmuxPaneId} is dead`)
  const evaluate = (tail: string) => {
    if (matcher) return matcher(tail)
    return tail !== baselineTail
  }
  if (evaluate(baselineTail))
    return {
      matched: !!matcher,
      changed: !matcher,
      waitId,
      elapsedMs: 0,
      output: capTail(baselineTail, count).join('\n'),
    }
  while (now() - startedAt < timeoutMs) {
    await sleep(pollMs)
    let occupant: { command: string; dead: boolean }
    let tail: string
    try {
      occupant = await readOccupant()
      tail = await readTail()
    } catch {
      throw new AgentWaitError('PANE_REMOVED', `Pane ${tmuxPaneId} was removed during output wait`)
    }
    if (evaluate(tail))
      return {
        matched: !!matcher,
        changed: !matcher,
        waitId,
        elapsedMs: now() - startedAt,
        output: capTail(tail, count).join('\n'),
      }
    if (occupant.dead || occupant.command !== baseline.command)
      throw new AgentWaitError(
        'OCCUPANT_CHANGED',
        `Pane ${tmuxPaneId} occupant changed from ${baseline.command || 'unknown'} to ${occupant.command || 'dead'}`,
      )
  }
  throw new AgentWaitError('TIMEOUT', `Pane output wait timed out after ${timeoutMs}ms`)
}

// run 文本只允许字面可打印字符 + tab：\n/\r/其他控制字符会被 tmux 当成
// 按键动作（隐式 Enter/转义序列），必须走显式 enter 参数
function hasUnsafeRunChar(text: string) {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code === 0x7f || (code < 0x20 && code !== 0x09)) return true
  }
  return false
}
export interface RunAgentPaneInputOptions {
  text: string
  enter?: boolean
  allowOccupied?: boolean
  exec?: TmuxExecFn
  inspect?: PaneInspectFn
}
// 最小安全语义：复用 recovery 的 pane 占用检查（同一份 occupant 语义），
// 只向非 dead/非 mode 的 pane 送字面按键；非 shell occupant 需显式 allowOccupied。
// 输入经 send-keys -l 字面模式 + 独立 Enter 分两次下发（recovery 同款：
// %0 pane-id 解析 bug 用坐标 target 规避）
export async function runAgentPaneInput(
  hostId: string,
  tmuxPaneId: string,
  options: RunAgentPaneInputOptions,
): Promise<{ ok: true; paneId: string; target: string }> {
  const text = options.text || ''
  if (!text || text.length > 4096 || hasUnsafeRunChar(text))
    throw new AgentWaitError('INVALID_INPUT', 'run text must be 1-4096 printable characters without control codes')
  const exec = options.exec || ((h, a, o) => execTmux(h, a, o).then((r) => ({ stdout: r.stdout })))
  const inspect = options.inspect || ((h, p) => inspectRecoveryPane(h, p))
  const inspection = await inspect(hostId, tmuxPaneId)
  if (inspection.state === 'missing') throw new AgentWaitError('PANE_MISSING', `Pane ${tmuxPaneId} does not exist`)
  if (inspection.state === 'dead') throw new AgentWaitError('PANE_DEAD', `Pane ${tmuxPaneId} is dead`)
  if (inspection.state === 'in_mode')
    throw new AgentWaitError('PANE_IN_MODE', `Pane ${tmuxPaneId} is in a tmux mode; keys would be swallowed`)
  if (inspection.state === 'unknown') throw new Error(`Pane ${tmuxPaneId} state is unknown; refusing to send input`)
  if (inspection.state === 'occupied' && options.allowOccupied !== true)
    throw new AgentWaitError(
      'PANE_OCCUPIED',
      `Pane ${tmuxPaneId} is occupied by ${inspection.command || 'another process'}; set allowOccupied to confirm`,
    )
  const target = inspection.target || tmuxPaneId
  await exec(hostId, ['send-keys', '-l', '-t', target, text], { timeoutMs: 8000 })
  if (options.enter !== false) await exec(hostId, ['send-keys', '-t', target, 'Enter'], { timeoutMs: 8000 })
  return { ok: true as const, paneId: `${hostId}:${tmuxPaneId}`, target }
}
