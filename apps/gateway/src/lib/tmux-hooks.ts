import { createHash } from 'crypto'
import { execHostShell, execTmux } from './tmux-executor.js'

export type TmuxAgentHookName = 'pane-exited' | 'pane-died' | 'pane-command-started' | 'pane-command-finished'
export interface TmuxAgentHookEvent {
  paneId: string
  sessionName?: string
  event: TmuxAgentHookName
  deadStatus?: string
  commandStatus?: string
}
export const tmuxAgentHookMarker = 'tmuxgo-agent-monitor:v2'
const legacyTmuxAgentHookMarkers = ['tmuxgo-agent-monitor:v1']
const hookNames: TmuxAgentHookName[] = ['pane-exited', 'pane-died', 'pane-command-started', 'pane-command-finished']
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
export function getTmuxAgentHookQueuePath(hostId: string) {
  const key = createHash('sha256').update(hostId).digest('hex').slice(0, 20)
  return `/tmp/tmuxgo-agent-monitor-${key}.ndjson`
}
function hookCommand(event: TmuxAgentHookName, queuePath: string) {
  const record = `${tmuxAgentHookMarker}\\t#{pane_id}\\t#{session_name}\\t${event}\\t#{pane_dead_status}\\t#{pane_command_status}`
  const command = `printf '%b\\n' ${shellQuote(record)} >> ${shellQuote(queuePath)}`
  return `run-shell -b ${shellQuote(command)}`
}
function hookIndex(line: string, event: TmuxAgentHookName) {
  const match = line.match(new RegExp(`^${event.replace('-', '\-')}\\[(\\d+)\\]`))
  return match ? Number(match[1]) : null
}
async function removeOwnHooks(hostId: string, event: TmuxAgentHookName, output: string) {
  const indexes = output.split(/\r?\n/).filter((line) => [tmuxAgentHookMarker, ...legacyTmuxAgentHookMarkers].some((marker) => line.includes(marker))).map((line) => hookIndex(line, event)).filter((index): index is number => index !== null).sort((left, right) => right - left)
  for (const index of indexes) {
    try {
      await execTmux(hostId, ['set-hook', '-g', '-u', `${event}[${index}]`])
    } catch {}
  }
}
export async function installTmuxAgentHooks(hostId: string) {
  const queuePath = getTmuxAgentHookQueuePath(hostId)
  for (const event of hookNames) {
    let existing = ''
    try {
      existing = (await execTmux(hostId, ['show-hooks', '-g', event])).stdout
    } catch {}
    if (existing.includes(tmuxAgentHookMarker)) continue
    await removeOwnHooks(hostId, event, existing)
    try {
      await execTmux(hostId, ['set-hook', '-g', '-a', event, hookCommand(event, queuePath)])
    } catch {}
  }
}
export async function consumeTmuxAgentHookEvents(hostId: string) {
  const queuePath = getTmuxAgentHookQueuePath(hostId)
  const readCommand = `if [ -f ${shellQuote(queuePath)} ]; then temporary=${shellQuote(queuePath)}.$$.read; mv ${shellQuote(queuePath)} "$temporary" 2>/dev/null || exit 0; trap 'rm -f "$temporary"' EXIT; cat "$temporary"; fi`
  try {
    const { stdout } = await execHostShell(hostId, readCommand, { timeoutMs: 5000 })
    return parseTmuxAgentHookEvents(stdout)
  } catch {
    return []
  }
}
export async function consumeTmuxAgentHookEvent(hostId: string) {
  return (await consumeTmuxAgentHookEvents(hostId)).at(-1) || null
}
function parseTmuxAgentHookFields(fields: string[]): TmuxAgentHookEvent | null {
  const [, paneId, third, fourth, fifth, sixth] = fields
  const hasSession = !hookNames.includes(third as TmuxAgentHookName)
  const sessionName = hasSession && third ? third : undefined
  const event = (hasSession ? fourth : third) as TmuxAgentHookName
  const deadStatus = hasSession ? fifth : fourth
  const commandStatus = hasSession ? sixth : fifth
  if (!paneId?.startsWith('%') || !hookNames.includes(event)) return null
  return { paneId, ...(sessionName ? { sessionName } : {}), event, deadStatus, commandStatus } satisfies TmuxAgentHookEvent
}
export function parseTmuxAgentHookEvent(value: string) {
  const marker = [tmuxAgentHookMarker, ...legacyTmuxAgentHookMarkers].find((item) => value.startsWith(item + '\t') || value.startsWith(item + '|'))
  if (!marker) return null
  if (value.startsWith(marker + '\t')) return parseTmuxAgentHookFields(value.split('\t'))
  if (value.startsWith(marker + '|')) return parseTmuxAgentHookFields(value.split('|'))
  return null
}
export function parseTmuxAgentHookEvents(value: string) {
  return value.split(/\r?\n/).map((line) => parseTmuxAgentHookEvent(line)).filter((event): event is TmuxAgentHookEvent => !!event)
}
