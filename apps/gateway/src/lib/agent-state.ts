import { getVisibleTerminalLines } from './terminal-output.js'
import { execHostShell, execTmux } from './tmux-executor.js'
import { findChildProcessAgents, parseOsc133Events, type Osc133Event } from './agent-signals.js'
import {
  consumeTmuxAgentHookEvents,
  getTmuxAgentHookQueuePath,
  installTmuxAgentHooks,
  parseTmuxAgentHookEvents,
  tmuxAgentHookNames,
  type TmuxAgentHookEvent,
  type TmuxAgentHookName,
} from './tmux-hooks.js'
import { getHostById, type HostRecord } from './hosts.js'
import { matchAgentScreenRule, type ScreenRule } from './agent-screen-rules.js'

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export type AgentPhase =
  | 'idle'
  | 'working'
  | 'needs_input'
  | 'permission_required'
  | 'retrying'
  | 'failed'
  | 'ended'
  | 'disconnected'
  | 'unknown'
export type AgentEvent =
  | 'started'
  | 'permission_required'
  | 'question_required'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'ended'
  | 'disconnected'
  | 'reconnected'
export type AgentSource = 'protocol' | 'hook' | 'tmux' | 'osc133' | 'process' | 'pane_output'
export type AgentConfidence = 'high' | 'medium' | 'low'
export interface AgentDisplayMetadata {
  title?: string
  stateLabel?: string
  tokens?: number
  seq?: number
  // display patch 来源标识：多来源各自维护 seq，仅同 source 的旧 seq 可丢弃 patch；
  // 不带 source 的旧客户端走默认桶，行为与引入 source 前一致
  source?: string
  ttlMs?: number
  updatedAt?: string
}
export interface AgentPaneState {
  paneId: string
  tmuxPaneId: string
  sessionName: string
  agent: string
  agentSessionId?: string
  // 协议事件明确上报的原生会话 id（claude session/codex thread 等）；
  // scan 侧只合成占位 id，不写本字段——recovery 据此判定可 resume
  nativeAgentSessionId?: string
  // pane_current_path：仅作 recovery manifest 的 cwd 快照；不计入 samePane，
  // agent 在 pane 里 cd 不会触发状态变更事件
  cwd?: string
  agentStatus: AgentStatus
  revision: number
  // monitor 物化序号：pane 状态内容真实变化时递增，agent.wait 以此做基线
  // 丢弃 wait 建立前已存在的旧状态回放；可选，缺省走旧行为
  stateSeq?: number
  phase?: AgentPhase
  lastEvent?: AgentEvent
  source?: AgentSource
  confidence?: AgentConfidence
  since?: string
  updatedAt?: string
  eventId?: string
  message?: string
  display?: AgentDisplayMetadata
}
interface PaneCandidate {
  paneId: string
  tmuxPaneId: string
  panePid: string
  sessionName: string
  currentCommand: string
  title: string
  paneDead: boolean
  paneDeadStatus: string
  lastOutputTime: string
  currentPath: string
  commandRunning: boolean
  commandStatus: string
  commandDuration: string
  osc133Event?: Osc133Event
  tmuxHookEvent?: TmuxAgentHookEvent
}
interface AgentRecord extends AgentPaneState {
  rawStatus: AgentStatus
  rawPhase: AgentPhase
  lastOutputTime: string
  paneDead: boolean
}
export function shouldSkipCapture(
  previous: AgentRecord | undefined,
  candidate: PaneCandidate,
): previous is AgentRecord {
  return (
    !!previous &&
    !candidate.tmuxHookEvent &&
    !!candidate.lastOutputTime &&
    previous.lastOutputTime === candidate.lastOutputTime &&
    previous.paneDead === candidate.paneDead
  )
}
interface AgentDetection {
  agent: string
  agentStatus: AgentStatus
  phase: AgentPhase
  source: AgentSource
  confidence: AgentConfidence
  message?: string
}
const records = new Map<string, AgentRecord>()
const scans = new Map<string, { expiresAt: number; promise: Promise<AgentPaneState[]> }>()
let nextRevision = Date.now()
const directAgents: Record<string, string> = {
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  opencode: 'opencode',
  gemini: 'gemini',
  aider: 'aider',
  amp: 'amp',
  pi: 'pi',
  kimi: 'kimi',
  droid: 'droid',
  reasonix: 'reasonix',
  'cursor-agent': 'cursor',
  copilot: 'copilot',
  devin: 'devin',
  'devin-cli': 'devin',
  'dsh-tui': 'dsh-tui',
  dst: 'dsh-tui',
  // dsh-tui 是 launcher：实际前台进程是 `dsh --profile dsh-tui`，comm 名为 dsh
  dsh: 'dsh-tui',
  mimo: 'mimo',
  'kimi-code': 'kimi',
  opencode2: 'opencode',
}
const indirectCommands = new Set(['node', 'bun', 'deno', 'python', 'python3'])
const spinnerPattern = /(?:^|\s)[\u2800-\u28ff](?:\s|$)/u
const blockedPattern =
  /(action required|allow command\?|press enter to confirm|enter to submit(?: answer| all)?|would you like to|do you want to proceed|\[y\/n\]|permission required|requires your approval)/i
const permissionPattern = /(allow command\?|permission required|requires your approval|approve|approval|\[y\/n\])/i
const questionPattern =
  /(enter to submit(?: answer| all)?|would you like to|do you want to proceed|what would you like|please answer|type your answer)/i
const workingPattern = /(?:^|\n)[•◦]\s+Working\s+\([^)]*esc to interrupt\)|esc to interrupt|press esc to interrupt/i
const retryPattern = /(?:retry|retrying|attempt\s+\d+)/i
const failurePattern = /(?:^|\n)\s*(?:error|failed|failure|fatal|exception)\s*:/i

function normalizeCommand(value: string) {
  return value.trim().toLowerCase().split(/[\\/]/).pop() || ''
}
export function detectProcessAgent(command: string) {
  const [executable, script] = command.trim().toLowerCase().split(/\s+/).map(normalizeCommand)
  if (directAgents[executable]) return directAgents[executable]
  if (indirectCommands.has(executable) && script && directAgents[script]) return directAgents[script]
  return null
}
function detectAgent(currentCommand: string, title: string, output: string, processAgent?: string | null) {
  if (processAgent !== undefined) return processAgent
  const command = normalizeCommand(currentCommand)
  if (directAgents[command]) return directAgents[command]
  const text = `${title}\n${output}`
  if (/gpt-[\w.-]+\s+(?:low|medium|high|xhigh)\s+·/i.test(text) || /Use \/skills to list available skills/i.test(text))
    return 'codex'
  if (
    indirectCommands.has(command) &&
    ((spinnerPattern.test(title) && workingPattern.test(output)) || blockedPattern.test(text))
  )
    return 'codex'
  if (/Claude Code|Bypassing Permissions|shift\+tab to cycle mode/i.test(text)) return 'claude'
  if (/OpenCode/i.test(text)) return 'opencode'
  if (/Gemini CLI/i.test(text)) return 'gemini'
  if (/Aider v?[\d.]+|aider chat/i.test(text)) return 'aider'
  if (/Kimi Code/i.test(text)) return 'kimi'
  return null
}
function detectRawStatus(title: string, output: string): AgentStatus {
  const recent = getVisibleTerminalLines(output).slice(-16).join('\n')
  const visible = `${title}\n${recent}`
  if (blockedPattern.test(visible)) return 'blocked'
  if (spinnerPattern.test(title) || spinnerPattern.test(recent) || workingPattern.test(recent)) return 'working'
  return 'idle'
}
function detectRawPhase(
  candidate: PaneCandidate,
  title: string,
  output: string,
  processAgent?: string | null,
  ruleHit?: ScreenRule | null,
) {
  const recent = getVisibleTerminalLines(output).slice(-16).join('\n')
  const visible = title + '\n' + recent
  const command = normalizeCommand(candidate.currentCommand)
  const osc133 = candidate.osc133Event
  const hook = candidate.tmuxHookEvent
  const source: AgentSource = hook
    ? 'hook'
    : osc133
      ? 'osc133'
      : processAgent !== undefined
        ? 'process'
        : directAgents[command]
          ? 'tmux'
          : 'pane_output'
  const confidence: AgentConfidence =
    hook || osc133 || processAgent !== undefined || directAgents[command] ? 'medium' : 'low'
  if (candidate.paneDead)
    return {
      phase: 'ended' as const,
      source: 'tmux' as const,
      confidence: 'high' as const,
      message: 'Agent process ended',
    }
  if (hook?.event === 'pane-exited' || hook?.event === 'pane-died')
    return {
      phase: 'ended' as const,
      source: 'hook' as const,
      confidence: 'high' as const,
      message: 'Agent process ended',
    }
  // per-agent 屏幕规则（herdr manifest 移植）优先于通用词面：词面按各家 TUI 抠过
  if (ruleHit)
    return {
      phase: ruleHit.state === 'blocked' ? (ruleHit.phase ?? 'permission_required') : ruleHit.state,
      source,
      confidence: 'medium' as const,
      message: ruleHit.state === 'blocked' ? 'Agent is waiting for input' : undefined,
    }
  if (permissionPattern.test(visible))
    return { phase: 'permission_required' as const, source, confidence, message: 'Agent is waiting for permission' }
  if (questionPattern.test(visible))
    return { phase: 'needs_input' as const, source, confidence, message: 'Agent is waiting for input' }
  if (retryPattern.test(visible))
    return { phase: 'retrying' as const, source, confidence, message: 'Agent is retrying' }
  if (hook?.event === 'pane-command-finished' || osc133?.type === 'command_finished') {
    const status = Number(hook?.commandStatus || osc133?.status || 0)
    if (status > 0) return { phase: 'failed' as const, source, confidence, message: 'Agent reported a failure' }
    return { phase: 'idle' as const, source, confidence }
  }
  if (
    failurePattern.test(visible) ||
    (!candidate.commandRunning && /^\d+$/.test(candidate.commandStatus) && Number(candidate.commandStatus) > 0)
  )
    return {
      phase: 'failed' as const,
      source: candidate.commandStatus ? ('tmux' as const) : source,
      confidence: candidate.commandStatus ? ('medium' as const) : confidence,
      message: 'Agent reported a failure',
    }
  if (
    hook?.event === 'pane-command-started' ||
    osc133?.type === 'command_started' ||
    osc133?.type === 'output_started' ||
    spinnerPattern.test(title) ||
    spinnerPattern.test(recent) ||
    workingPattern.test(recent) ||
    candidate.commandRunning
  )
    return { phase: 'working' as const, source, confidence }
  return { phase: 'idle' as const, source, confidence }
}
function toLegacyStatus(phase: AgentPhase, completed: boolean): AgentStatus {
  if (completed) return 'done'
  if (phase === 'permission_required' || phase === 'needs_input') return 'blocked'
  if (phase === 'working' || phase === 'retrying') return 'working'
  if (phase === 'idle') return 'idle'
  if (phase === 'unknown') return 'unknown'
  return 'unknown'
}
function getTransitionEvent(phase: AgentPhase, previousPhase?: AgentPhase): AgentEvent | undefined {
  if (!previousPhase) return undefined
  if (previousPhase === 'disconnected' && phase !== 'disconnected') return 'reconnected'
  if (phase === 'permission_required' && previousPhase !== phase) return 'permission_required'
  if (phase === 'needs_input' && previousPhase !== phase) return 'question_required'
  if (phase === 'retrying' && previousPhase !== phase) return 'retrying'
  if (phase === 'failed' && previousPhase !== phase) return 'failed'
  if (phase === 'ended' && previousPhase !== phase) return 'ended'
  if (phase === 'working' && previousPhase !== phase) return 'started'
  if (
    phase === 'idle' &&
    (previousPhase === 'working' ||
      previousPhase === 'retrying' ||
      previousPhase === 'permission_required' ||
      previousPhase === 'needs_input')
  )
    return 'completed'
  return undefined
}
function detectAgentObservation(
  candidate: PaneCandidate,
  output: string,
  processAgent?: string | null,
): AgentDetection | null {
  const agent = detectAgent(candidate.currentCommand, candidate.title, output, processAgent)
  if (!agent) return null
  const ruleHit = matchAgentScreenRule(agent, candidate.title, output)
  // 规则命中时 status 与 phase 同源（都出自 manifest 词面）；未命中回退通用正则
  const agentStatus = ruleHit
    ? ruleHit.state === 'idle'
      ? ('idle' as const)
      : ruleHit.state === 'working'
        ? ('working' as const)
        : ('blocked' as const)
    : detectRawStatus(candidate.title, output)
  const raw = detectRawPhase(candidate, candidate.title, output, processAgent, ruleHit)
  return { agent, agentStatus, ...raw }
}
export function detectAgentEvidence(
  currentCommand: string,
  title: string,
  output: string,
  processAgent?: string | null,
) {
  const candidate: PaneCandidate = {
    paneId: 'test:%0',
    tmuxPaneId: '%0',
    panePid: '',
    sessionName: 'test',
    currentCommand,
    title,
    paneDead: false,
    paneDeadStatus: '',
    lastOutputTime: '',
    currentPath: '',
    commandRunning: false,
    commandStatus: '',
    commandDuration: '',
  }
  return detectAgentObservation(candidate, output, processAgent)
}
export function detectAgentPaneState(
  currentCommand: string,
  title: string,
  output: string,
  processAgent?: string | null,
) {
  const agent = detectAgent(currentCommand, title, output, processAgent)
  return agent ? { agent, agentStatus: detectRawStatus(title, output) } : null
}
export function resolveAgentStatus(rawStatus: AgentStatus, previousStatus?: AgentStatus): AgentStatus {
  if (
    rawStatus === 'idle' &&
    (previousStatus === 'working' || previousStatus === 'blocked' || previousStatus === 'done')
  )
    return 'done'
  return rawStatus
}
function toAgentPaneState(record: AgentRecord): AgentPaneState {
  const { rawStatus, rawPhase, ...state } = record
  return state
}
function updateRecord(
  candidate: PaneCandidate,
  output: string,
  processAgent?: string | null,
  processScanFailed = false,
) {
  const detected = detectAgentObservation(candidate, output, processAgent)
  if (!detected) {
    if (processScanFailed) {
      const previous = records.get(candidate.paneId)
      if (previous) return toAgentPaneState(previous)
    }
    records.delete(candidate.paneId)
    return null
  }
  const previous = records.get(candidate.paneId)
  const sameAgent = previous?.agent === detected.agent
  const previousPhase = sameAgent ? previous?.rawPhase : undefined
  const transitionEvent = getTransitionEvent(detected.phase, previousPhase)
  const completed = detected.phase === 'idle' && transitionEvent === 'completed'
  const agentStatus = toLegacyStatus(detected.phase, completed)
  const now = new Date().toISOString()
  const lastEvent = transitionEvent || (sameAgent ? previous?.lastEvent : undefined)
  const eventId = transitionEvent
    ? candidate.paneId + ':' + candidate.sessionName + ':' + transitionEvent + ':' + now
    : sameAgent
      ? previous?.eventId
      : candidate.paneId + ':' + candidate.sessionName + ':state:' + now
  const since = !sameAgent || previous?.rawPhase !== detected.phase ? now : previous?.since || now
  if (
    sameAgent &&
    previous?.agentStatus === agentStatus &&
    previous.rawStatus === detected.agentStatus &&
    previous.rawPhase === detected.phase &&
    previous.lastEvent === lastEvent &&
    previous.eventId === eventId &&
    previous.message === detected.message
  )
    return toAgentPaneState(previous)
  const record: AgentRecord = {
    paneId: candidate.paneId,
    tmuxPaneId: candidate.tmuxPaneId,
    sessionName: candidate.sessionName,
    agent: detected.agent,
    agentSessionId: candidate.paneId + ':' + candidate.sessionName,
    agentStatus,
    rawStatus: detected.agentStatus,
    rawPhase: detected.phase,
    phase: detected.phase,
    lastEvent,
    source: detected.source,
    confidence: detected.confidence,
    since,
    updatedAt: now,
    eventId,
    message: detected.message,
    revision: ++nextRevision,
    cwd: candidate.currentPath || undefined,
    lastOutputTime: candidate.lastOutputTime,
    paneDead: candidate.paneDead,
  }
  records.set(candidate.paneId, record)
  return toAgentPaneState(record)
}
function shouldCapture(candidate: PaneCandidate) {
  const command = normalizeCommand(candidate.currentCommand)
  return (
    !!directAgents[command] ||
    indirectCommands.has(command) ||
    spinnerPattern.test(candidate.title) ||
    blockedPattern.test(candidate.title) ||
    !!candidate.tmuxHookEvent ||
    candidate.paneDead
  )
}
const processAgentCache = new Map<string, { expiresAt: number; pids: string[]; agents: Map<string, string> }>()
async function getProcessAgents(hostId: string, candidates: PaneCandidate[]) {
  const panePids = [
    ...new Set(candidates.map((candidate) => candidate.panePid).filter((panePid) => /^\d+$/.test(panePid))),
  ]
  if (!panePids.length) return new Map<string, string>()
  const cached = processAgentCache.get(hostId)
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.pids.length === panePids.length &&
    panePids.every((panePid) => cached.pids.includes(panePid))
  )
    return cached.agents
  try {
    const { stdout } = await execHostShell(hostId, 'ps -ww -eo pid=,ppid=,args=', { timeoutMs: 5000 })
    const agents = findChildProcessAgents(stdout, panePids, detectProcessAgent)
    processAgentCache.set(hostId, { expiresAt: Date.now() + 5000, pids: panePids, agents })
    return agents
  } catch {
    return null
  }
}
const paneListFormat =
  '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_last_output_time}\t#{pane_current_path}\t#{pane_command_running}\t#{pane_command_status}\t#{pane_command_duration}'
// 远端 scan 输出分段标记：\x1e<NAME> 行起新段，HOOKS 段内各事件以 \x1f 分隔
const scanSectionMarker = '\x1e'
const scanHookSep = '\x1f'
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
// SSH 主机把整轮探测合进单个 `sh -lc` exec：每个 ssh channel 的加密往返 ~10KB，
// 6 个独立 exec 的 1.5s 轮询曾是 tailscale 上的主要流量来源
function buildRemoteScanScript(host: HostRecord, sessionName: string | undefined) {
  const listArgs = sessionName ? `list-panes -s -t ${shellQuote(sessionName)}` : 'list-panes -a'
  return [
    `TMUX=${shellQuote(host.tmuxPath || 'tmux')}`,
    `QUEUE=${shellQuote(getTmuxAgentHookQueuePath(host.id))}`,
    `printf '\\036HOOKS\\n'`,
    `for e in ${tmuxAgentHookNames.join(' ')}; do printf '%s\\n' "$e"; "$TMUX" show-hooks -g "$e" 2>&1; printf '\\037\\n'; done`,
    `printf '\\036QUEUE\\n'`,
    `if [ -f "$QUEUE" ]; then r="$QUEUE.$$.r"; if mv "$QUEUE" "$r" 2>/dev/null; then cat "$r"; rm -f "$r"; fi; fi`,
    `printf '\\036PANES\\n'`,
    `panes=$("$TMUX" ${listArgs} -F ${shellQuote(paneListFormat)} 2>&1); rc=$?`,
    `printf '%s\\n' "$panes"`,
    `printf '\\036PS\\n'`,
    // findChildProcessAgents 只沿 pane 子孙按 ppid 遍历：pgrep -P 递归拿子树，
    // 远端过滤后仅需返回百字节级输出；无 pgrep 的系统回退全量 ps
    `if command -v pgrep >/dev/null 2>&1; then`,
    `D=" "`,
    `collect() { for c in $(pgrep -P "$1" 2>/dev/null); do case "$D" in *" $c "*) ;; *) D="$D$c "; collect "$c";; esac; done }`,
    `for pp in $(printf '%s\\n' "$panes" | cut -f3); do collect "$pp"; done`,
    `D="\${D# }"; D="\${D% }"`,
    `if [ -n "$D" ]; then ps -ww -o pid=,ppid=,args= -p "$(printf '%s' "$D" | tr ' ' ',')" 2>/dev/null; fi`,
    `else`,
    `ps -ww -eo pid=,ppid=,args= 2>/dev/null`,
    `fi`,
    `printf '\\036RC\\n%d\\n' "$rc"`,
  ].join('\n')
}
function splitScanSections(stdout: string) {
  const sections = new Map<string, string>()
  let current = ''
  let buffer: string[] = []
  const flush = () => {
    if (current) sections.set(current, buffer.join('\n'))
    buffer = []
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith(scanSectionMarker)) {
      flush()
      current = line.slice(1).trim()
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}
function parseScanHookOutputs(raw: string) {
  const outputs = new Map<TmuxAgentHookName, string>()
  for (const block of raw.split(scanHookSep)) {
    // 分隔符 \x1f 自带 \n 结束符，后续块以换行开头——先剥掉再取事件名
    const body = block.replace(/^\n+/, '')
    const newline = body.indexOf('\n')
    if (newline <= 0) continue
    const event = body.slice(0, newline).trim() as TmuxAgentHookName
    if (tmuxAgentHookNames.includes(event)) outputs.set(event, body.slice(newline + 1))
  }
  return outputs
}
function parsePaneCandidates(
  hostId: string,
  stdout: string,
  allowedSessionNames: string[] | undefined,
  tmuxHookEvents: TmuxAgentHookEvent[],
) {
  const allowedSessions = allowedSessionNames ? new Set(allowedSessionNames) : null
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): PaneCandidate => {
      const [
        paneSessionName,
        tmuxPaneId,
        panePid,
        currentCommand,
        title,
        paneDead,
        paneDeadStatus,
        lastOutputTime,
        currentPath,
        commandRunning,
        commandStatus,
        commandDuration,
      ] = line.split('\t')
      return {
        paneId: `${hostId}:${tmuxPaneId}`,
        tmuxPaneId,
        panePid,
        sessionName: paneSessionName,
        currentCommand,
        title: title || '',
        paneDead: paneDead === '1',
        paneDeadStatus: paneDeadStatus || '',
        lastOutputTime: lastOutputTime || '',
        currentPath: currentPath || '',
        commandRunning: commandRunning === '1',
        commandStatus: commandStatus || '',
        commandDuration: commandDuration || '',
        tmuxHookEvent: tmuxHookEvents.filter((event) => event.paneId === tmuxPaneId).at(-1),
      }
    })
    .filter(
      (candidate) =>
        candidate.tmuxPaneId?.startsWith('%') && (!allowedSessions || allowedSessions.has(candidate.sessionName)),
    )
}
async function captureAgentStates(
  hostId: string,
  candidates: PaneCandidate[],
  processAgents: Map<string, string> | null,
) {
  const processScanFailed = processAgents === null
  const agentCandidates = candidates.filter(
    (candidate) => shouldCapture(candidate) || !!processAgents?.get(candidate.panePid) || records.has(candidate.paneId),
  )
  const states: AgentPaneState[] = []
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(hostId === 'local' ? 8 : 4, agentCandidates.length) }, async () => {
      while (index < agentCandidates.length) {
        const candidate = agentCandidates[index++]
        const previous = records.get(candidate.paneId)
        if (shouldSkipCapture(previous, candidate)) {
          states.push(toAgentPaneState(previous))
          continue
        }
        try {
          const { stdout: output } = await execTmux(
            hostId,
            ['capture-pane', '-e', '-p', '-t', candidate.tmuxPaneId, '-S', '-80'],
            { timeoutMs: 2000 },
          )
          const processAgent = processAgents ? processAgents.get(candidate.panePid) : undefined
          candidate.osc133Event = parseOsc133Events(output).at(-1)
          const state = updateRecord(candidate, output, processAgent, processScanFailed)
          if (state) states.push(state)
        } catch {
          const previous = records.get(candidate.paneId)
          if (previous) states.push(toAgentPaneState(previous))
        }
      }
    }),
  )
  return states.sort((a, b) => a.paneId.localeCompare(b.paneId))
}
// SSH 远端：单次 exec 内带回 hooks/事件队列/pane 列表/进程子树；任一关键段缺失按失败处理，
// 与旧路径「list-panes 失败 → 整轮 disconnected」语义一致
async function scanRemoteAgentPanes(host: HostRecord, sessionName?: string, allowedSessionNames?: string[]) {
  const hostId = host.id
  const { stdout } = await execHostShell(hostId, buildRemoteScanScript(host, sessionName), { timeoutMs: 15000 })
  const sections = splitScanSections(stdout)
  const panesRaw = sections.get('PANES')
  // list-panes 失败（无 tmux server / 目标 session 不存在）须维持旧语义：scan 失败 → disconnected
  if (panesRaw === undefined || Number(sections.get('RC')?.trim() || '0') !== 0)
    throw new Error('Remote agent scan failed to list panes')
  const hooksRaw = sections.get('HOOKS')
  await installTmuxAgentHooks(hostId, hooksRaw === undefined ? undefined : parseScanHookOutputs(hooksRaw)).catch(
    () => {},
  )
  const tmuxHookEvents = parseTmuxAgentHookEvents(sections.get('QUEUE') || '')
  const candidates = parsePaneCandidates(hostId, panesRaw, allowedSessionNames, tmuxHookEvents)
  const psRaw = sections.get('PS')
  const panePids = candidates.map((candidate) => candidate.panePid).filter((panePid) => /^\d+$/.test(panePid))
  const processAgents =
    psRaw === undefined ? null : findChildProcessAgents(psRaw, [...new Set(panePids)], detectProcessAgent)
  return captureAgentStates(hostId, candidates, processAgents)
}
async function scanAgentPanes(hostId: string, sessionName?: string, allowedSessionNames?: string[]) {
  const host = await getHostById(hostId).catch(() => null)
  if (host && host.id !== 'local') return scanRemoteAgentPanes(host, sessionName, allowedSessionNames)
  await installTmuxAgentHooks(hostId).catch(() => {})
  const tmuxHookEvents = await consumeTmuxAgentHookEvents(hostId)
  const args = sessionName ? ['list-panes', '-s', '-t', sessionName] : ['list-panes', '-a']
  args.push('-F', paneListFormat)
  const { stdout } = await execTmux(hostId, args)
  const candidates = parsePaneCandidates(hostId, stdout, allowedSessionNames, tmuxHookEvents)
  const processAgents = await getProcessAgents(hostId, candidates)
  return captureAgentStates(hostId, candidates, processAgents)
}
function getAgentPanes(hostId: string, sessionName?: string, allowedSessionNames?: string[]) {
  const key = `${hostId}:${sessionName || '*'}:${allowedSessionNames?.slice().sort().join(',') || '*'}`
  const cached = scans.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.promise
  const promise = scanAgentPanes(hostId, sessionName, allowedSessionNames).finally(() => {
    const current = scans.get(key)
    if (current?.promise === promise && current.expiresAt <= Date.now()) scans.delete(key)
  })
  scans.set(key, { expiresAt: Date.now() + 750, promise })
  return promise
}
export function getHostAgentPanes(hostId: string, allowedSessionNames?: string[]) {
  return getAgentPanes(hostId, undefined, allowedSessionNames)
}
export function getSessionAgentPanes(hostId: string, sessionName: string) {
  return getAgentPanes(hostId, sessionName)
}
// 仅 done→idle 真实翻转时返回新态；无记录/非 done 返回 null——
// 调用方据此区分「已标记」与「无可标记」（mark-seen 的 marked 计数依赖此语义）
export function markAgentPaneSeen(paneId: string) {
  const current = records.get(paneId)
  if (!current || current.agentStatus !== 'done') return null
  const next = { ...current, agentStatus: 'idle' as const, revision: ++nextRevision }
  records.set(paneId, next)
  return toAgentPaneState(next)
}
export function forgetAgentPane(paneId: string) {
  records.delete(paneId)
}
// 测试注入用：mark-seen 等路由用例需要不经 tmux scan 直接造 done/working 记录
export function _setAgentPaneRecordForTest(state: AgentPaneState) {
  records.set(state.paneId, {
    ...state,
    rawStatus: state.agentStatus,
    rawPhase: state.phase || 'unknown',
    lastOutputTime: '',
    paneDead: false,
  })
}
export function summarizeAgentPanes(states: AgentPaneState[]) {
  return states.reduce(
    (summary, state) => {
      summary[state.agentStatus] += 1
      summary.total += 1
      return summary
    },
    { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 },
  )
}
