import { getVisibleTerminalLines } from './terminal-output.js'
import { execTmux } from './tmux-executor.js'

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export interface AgentPaneState {
  paneId: string
  tmuxPaneId: string
  sessionName: string
  agent: string
  agentStatus: AgentStatus
  revision: number
}
interface PaneCandidate {
  paneId: string
  tmuxPaneId: string
  sessionName: string
  currentCommand: string
  title: string
}
interface AgentRecord extends AgentPaneState {
  rawStatus: AgentStatus
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
const workingPattern = /(?:^|\n)[•◦]\s+Working\s+\([^)]*esc to interrupt\)|esc to interrupt|press esc to interrupt/i

function normalizeCommand(value: string) {
  return value.trim().toLowerCase().split(/[\\/]/).pop() || ''
}
function detectAgent(currentCommand: string, title: string, output: string) {
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
export function detectAgentPaneState(currentCommand: string, title: string, output: string) {
  const agent = detectAgent(currentCommand, title, output)
  return agent ? { agent, agentStatus: detectRawStatus(title, output) } : null
}
export function resolveAgentStatus(rawStatus: AgentStatus, previousStatus?: AgentStatus): AgentStatus {
  if (rawStatus === 'idle' && (previousStatus === 'working' || previousStatus === 'blocked' || previousStatus === 'done')) return 'done'
  return rawStatus
}
function toAgentPaneState(record: AgentRecord): AgentPaneState {
  const { rawStatus, ...state } = record
  return state
}
function updateRecord(candidate: PaneCandidate, output: string) {
  const detected = detectAgentPaneState(candidate.currentCommand, candidate.title, output)
  if (!detected) {
    records.delete(candidate.paneId)
    return null
  }
  const previous = records.get(candidate.paneId)
  const agentStatus = resolveAgentStatus(detected.agentStatus, previous?.agent === detected.agent ? previous.agentStatus : undefined)
  if (previous?.agent === detected.agent && previous.agentStatus === agentStatus && previous.rawStatus === detected.agentStatus) return toAgentPaneState(previous)
  const record: AgentRecord = {
    paneId: candidate.paneId,
    tmuxPaneId: candidate.tmuxPaneId,
    sessionName: candidate.sessionName,
    agent: detected.agent,
    agentStatus,
    rawStatus: detected.agentStatus,
    revision: ++nextRevision,
  }
  records.set(candidate.paneId, record)
  return toAgentPaneState(record)
}
function shouldCapture(candidate: PaneCandidate) {
  const command = normalizeCommand(candidate.currentCommand)
  return !!directAgents[command] || indirectCommands.has(command) || spinnerPattern.test(candidate.title) || blockedPattern.test(candidate.title)
}
async function scanAgentPanes(hostId: string, sessionName?: string, allowedSessionNames?: string[]) {
  const args = sessionName ? ['list-panes', '-s', '-t', sessionName] : ['list-panes', '-a']
  args.push('-F', '#{session_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_title}')
  const { stdout } = await execTmux(hostId, args)
  const allowedSessions = allowedSessionNames ? new Set(allowedSessionNames) : null
  const candidates = stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [paneSessionName, tmuxPaneId, currentCommand, title] = line.split('\t')
    return { paneId: `${hostId}:${tmuxPaneId}`, tmuxPaneId, sessionName: paneSessionName, currentCommand, title: title || '' }
  }).filter((candidate) => candidate.tmuxPaneId?.startsWith('%') && (!allowedSessions || allowedSessions.has(candidate.sessionName)) && shouldCapture(candidate))
  const states: AgentPaneState[] = []
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (index < candidates.length) {
      const candidate = candidates[index++]
      try {
        const { stdout: output } = await execTmux(hostId, ['capture-pane', '-p', '-t', candidate.tmuxPaneId, '-S', '-80'])
        const state = updateRecord(candidate, output)
        if (state) states.push(state)
      } catch {}
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
export function summarizeAgentPanes(states: AgentPaneState[]) {
  return states.reduce((summary, state) => {
    summary[state.agentStatus] += 1
    summary.total += 1
    return summary
  }, { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 })
}
