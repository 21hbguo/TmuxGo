import { getVisibleTerminalLines } from './terminal-output.js'
import { execHostShell, execTmux } from './tmux-executor.js'
import { findChildProcessAgents, parseOsc133Events, type Osc133Event } from './agent-signals.js'
import { consumeTmuxAgentHookEvents, installTmuxAgentHooks, type TmuxAgentHookEvent } from './tmux-hooks.js'

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export type AgentPhase = 'idle' | 'working' | 'needs_input' | 'permission_required' | 'retrying' | 'failed' | 'ended' | 'disconnected' | 'unknown'
export type AgentEvent = 'started' | 'permission_required' | 'question_required' | 'completed' | 'failed' | 'retrying' | 'ended' | 'disconnected' | 'reconnected'
export type AgentSource = 'protocol' | 'hook' | 'tmux' | 'osc133' | 'process' | 'pane_output'
export type AgentConfidence = 'high' | 'medium' | 'low'
export interface AgentPaneState {
  paneId: string
  tmuxPaneId: string
  sessionName: string
  agent: string
  agentSessionId?: string
  agentStatus: AgentStatus
  revision: number
  phase?: AgentPhase
  lastEvent?: AgentEvent
  source?: AgentSource
  confidence?: AgentConfidence
  since?: string
  updatedAt?: string
  eventId?: string
  message?: string
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
  commandRunning: boolean
  commandStatus: string
  commandDuration: string
  osc133Event?: Osc133Event
  tmuxHookEvent?: TmuxAgentHookEvent
}
interface AgentRecord extends AgentPaneState {
  rawStatus: AgentStatus
  rawPhase: AgentPhase
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
  'cursor-agent': 'cursor',
  copilot: 'copilot',
}
const indirectCommands = new Set(['node', 'bun', 'deno', 'python', 'python3'])
const spinnerPattern = /(?:^|\s)[\u2800-\u28ff](?:\s|$)/u
const blockedPattern = /(action required|allow command\?|press enter to confirm|enter to submit(?: answer| all)?|would you like to|do you want to proceed|\[y\/n\]|permission required|requires your approval)/i
const permissionPattern = /(allow command\?|permission required|requires your approval|approve|approval|\[y\/n\])/i
const questionPattern = /(enter to submit(?: answer| all)?|would you like to|do you want to proceed|what would you like|please answer|type your answer)/i
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
  if (/gpt-[\w.-]+\s+(?:low|medium|high|xhigh)\s+·/i.test(text) || /Use \/skills to list available skills/i.test(text)) return 'codex'
  if (indirectCommands.has(command) && (spinnerPattern.test(title) && workingPattern.test(output) || blockedPattern.test(text))) return 'codex'
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
  if (spinnerPattern.test(title) || workingPattern.test(recent)) return 'working'
  return 'idle'
}
function detectRawPhase(candidate: PaneCandidate, title: string, output: string, processAgent?: string | null) {
  const recent = getVisibleTerminalLines(output).slice(-16).join('\n')
  const visible = title + '\n' + recent
  const command = normalizeCommand(candidate.currentCommand)
  const osc133 = candidate.osc133Event
  const hook = candidate.tmuxHookEvent
  const source: AgentSource = hook ? 'hook' : osc133 ? 'osc133' : processAgent !== undefined ? 'process' : directAgents[command] ? 'tmux' : 'pane_output'
  const confidence: AgentConfidence = hook || osc133 || processAgent !== undefined || directAgents[command] ? 'medium' : 'low'
  if (candidate.paneDead) return { phase: 'ended' as const, source: 'tmux' as const, confidence: 'high' as const, message: 'Agent process ended' }
  if (hook?.event === 'pane-exited' || hook?.event === 'pane-died') return { phase: 'ended' as const, source: 'hook' as const, confidence: 'high' as const, message: 'Agent process ended' }
  if (permissionPattern.test(visible)) return { phase: 'permission_required' as const, source, confidence, message: 'Agent is waiting for permission' }
  if (questionPattern.test(visible)) return { phase: 'needs_input' as const, source, confidence, message: 'Agent is waiting for input' }
  if (retryPattern.test(visible)) return { phase: 'retrying' as const, source, confidence, message: 'Agent is retrying' }
  if (hook?.event === 'pane-command-finished' || osc133?.type === 'command_finished') {
    const status = Number(hook?.commandStatus || osc133?.status || 0)
    if (status > 0) return { phase: 'failed' as const, source, confidence, message: 'Agent reported a failure' }
    return { phase: 'idle' as const, source, confidence }
  }
  if (failurePattern.test(visible) || (!candidate.commandRunning && /^\d+$/.test(candidate.commandStatus) && Number(candidate.commandStatus) > 0)) return { phase: 'failed' as const, source: candidate.commandStatus ? 'tmux' as const : source, confidence: candidate.commandStatus ? 'medium' as const : confidence, message: 'Agent reported a failure' }
  if (hook?.event === 'pane-command-started' || osc133?.type === 'command_started' || osc133?.type === 'output_started' || spinnerPattern.test(title) || workingPattern.test(recent) || candidate.commandRunning) return { phase: 'working' as const, source, confidence }
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
  if (phase === 'idle' && (previousPhase === 'working' || previousPhase === 'retrying' || previousPhase === 'permission_required' || previousPhase === 'needs_input')) return 'completed'
  return undefined
}
function detectAgentObservation(candidate: PaneCandidate, output: string, processAgent?: string | null): AgentDetection | null {
  const detected = processAgent === undefined ? detectAgentPaneState(candidate.currentCommand, candidate.title, output) : detectAgentPaneState(candidate.currentCommand, candidate.title, output, processAgent)
  if (!detected) return null
  const raw = detectRawPhase(candidate, candidate.title, output, processAgent)
  return { ...detected, ...raw }
}
export function detectAgentEvidence(currentCommand: string, title: string, output: string, processAgent?: string | null) {
  const candidate: PaneCandidate = { paneId: 'test:%0', tmuxPaneId: '%0', panePid: '', sessionName: 'test', currentCommand, title, paneDead: false, paneDeadStatus: '', lastOutputTime: '', commandRunning: false, commandStatus: '', commandDuration: '' }
  return detectAgentObservation(candidate, output, processAgent)
}
export function detectAgentPaneState(currentCommand: string, title: string, output: string, processAgent?: string | null) {
  const agent = detectAgent(currentCommand, title, output, processAgent)
  return agent ? { agent, agentStatus: detectRawStatus(title, output) } : null
}
export function resolveAgentStatus(rawStatus: AgentStatus, previousStatus?: AgentStatus): AgentStatus {
  if (rawStatus === 'idle' && (previousStatus === 'working' || previousStatus === 'blocked' || previousStatus === 'done')) return 'done'
  return rawStatus
}
function toAgentPaneState(record: AgentRecord): AgentPaneState {
  const { rawStatus, rawPhase, ...state } = record
  return state
}
function updateRecord(candidate: PaneCandidate, output: string, processAgent?: string | null, processScanFailed = false) {
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
  const eventId = transitionEvent ? candidate.paneId + ':' + candidate.sessionName + ':' + transitionEvent + ':' + now : sameAgent ? previous?.eventId : candidate.paneId + ':' + candidate.sessionName + ':state:' + now
  const since = !sameAgent || previous?.rawPhase !== detected.phase ? now : previous?.since || now
  if (sameAgent && previous?.agentStatus === agentStatus && previous.rawStatus === detected.agentStatus && previous.rawPhase === detected.phase && previous.lastEvent === lastEvent && previous.eventId === eventId && previous.message === detected.message) return toAgentPaneState(previous)
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
  }
  records.set(candidate.paneId, record)
  return toAgentPaneState(record)
}
function shouldCapture(candidate: PaneCandidate) {
  const command = normalizeCommand(candidate.currentCommand)
  return !!directAgents[command] || indirectCommands.has(command) || spinnerPattern.test(candidate.title) || blockedPattern.test(candidate.title) || !!candidate.tmuxHookEvent || candidate.paneDead
}
async function getProcessAgents(hostId: string, candidates: PaneCandidate[]) {
  const panePids = [...new Set(candidates.map((candidate) => candidate.panePid).filter((panePid) => /^\d+$/.test(panePid)))]
  if (!panePids.length) return new Map<string, string>()
  try {
    const { stdout } = await execHostShell(hostId, 'ps -ww -eo pid=,ppid=,args=', { timeoutMs: 5000 })
    return findChildProcessAgents(stdout, panePids, detectProcessAgent)
  } catch {
    return null
  }
}
async function scanAgentPanes(hostId: string, sessionName?: string, allowedSessionNames?: string[]) {
  await installTmuxAgentHooks(hostId).catch(() => {})
  const tmuxHookEvents = await consumeTmuxAgentHookEvents(hostId)
  const args = sessionName ? ['list-panes', '-s', '-t', sessionName] : ['list-panes', '-a']
  args.push('-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_last_output_time}\t#{pane_command_running}\t#{pane_command_status}\t#{pane_command_duration}')
  const { stdout } = await execTmux(hostId, args)
  const allowedSessions = allowedSessionNames ? new Set(allowedSessionNames) : null
  const candidates: PaneCandidate[] = stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [paneSessionName, tmuxPaneId, panePid, currentCommand, title, paneDead, paneDeadStatus, lastOutputTime, commandRunning, commandStatus, commandDuration] = line.split('\t')
    return { paneId: `${hostId}:${tmuxPaneId}`, tmuxPaneId, panePid, sessionName: paneSessionName, currentCommand, title: title || '', paneDead: paneDead === '1', paneDeadStatus: paneDeadStatus || '', lastOutputTime: lastOutputTime || '', commandRunning: commandRunning === '1', commandStatus: commandStatus || '', commandDuration: commandDuration || '', tmuxHookEvent: tmuxHookEvents.filter((event) => event.paneId === tmuxPaneId).at(-1) }
  }).filter((candidate) => candidate.tmuxPaneId?.startsWith('%') && (!allowedSessions || allowedSessions.has(candidate.sessionName)))
  const processAgents = await getProcessAgents(hostId, candidates)
  const processScanFailed = processAgents === null
  const agentCandidates = candidates.filter((candidate) => shouldCapture(candidate) || !!processAgents?.get(candidate.panePid) || records.has(candidate.paneId))
  const states: AgentPaneState[] = []
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, agentCandidates.length) }, async () => {
    while (index < agentCandidates.length) {
      const candidate = agentCandidates[index++]
      try {
        const { stdout: output } = await execTmux(hostId, ['capture-pane', '-e', '-p', '-t', candidate.tmuxPaneId, '-S', '-80'])
        const processAgent = processAgents ? processAgents.get(candidate.panePid) : undefined
        candidate.osc133Event = parseOsc133Events(output).at(-1)
        const state = updateRecord(candidate, output, processAgent, processScanFailed)
        if (state) states.push(state)
      } catch {
        const previous = records.get(candidate.paneId)
        if (previous) states.push(toAgentPaneState(previous))
      }
    }
  }))
  return states.sort((a, b) => a.paneId.localeCompare(b.paneId))
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
export function markAgentPaneSeen(paneId: string) {
  const current = records.get(paneId)
  if (!current || current.agentStatus !== 'done') return current ? toAgentPaneState(current) : null
  const next = { ...current, agentStatus: 'idle' as const, revision: ++nextRevision }
  records.set(paneId, next)
  return toAgentPaneState(next)
}
export function forgetAgentPane(paneId: string) {
  records.delete(paneId)
}
export function summarizeAgentPanes(states: AgentPaneState[]) {
  return states.reduce((summary, state) => {
    summary[state.agentStatus] += 1
    summary.total += 1
    return summary
  }, { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 })
}
