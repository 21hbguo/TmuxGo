export type Osc133EventType = 'prompt' | 'command_started' | 'output_started' | 'command_finished'
export interface Osc133Event {
  type: Osc133EventType
  status?: number
}
export interface ProcessTreeEntry {
  pid: string
  ppid: string
  command: string
}
const osc133Pattern = /\u001b\]133;([ABCD])(?:;([^\u0007\u001b]*))?(?:\u0007|\u001b\\)/g
export function parseOsc133Events(value: string) {
  const events: Osc133Event[] = []
  for (const match of value.matchAll(osc133Pattern)) {
    const code = match[1]
    if (code === 'A') events.push({ type: 'prompt' })
    else if (code === 'B') events.push({ type: 'command_started' })
    else if (code === 'C') events.push({ type: 'output_started' })
    else if (code === 'D') {
      const status = match[2] ? Number(match[2].split(';')[0]) : undefined
      events.push({ type: 'command_finished', ...(Number.isInteger(status) ? { status } : {}) })
    }
  }
  return events
}
export function parseProcessTree(stdout: string) {
  const entries: ProcessTreeEntry[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match) entries.push({ pid: match[1], ppid: match[2], command: match[3] })
  }
  return entries
}
export function findChildProcessAgents(stdout: string, panePids: string[], detect: (command: string) => string | null) {
  const entries = parseProcessTree(stdout)
  const agents = new Map<string, string>()
  const children = new Map<string, ProcessTreeEntry[]>()
  for (const entry of entries) {
    const list = children.get(entry.ppid) || []
    list.push(entry)
    children.set(entry.ppid, list)
  }
  for (const list of children.values()) list.sort((left, right) => Number(left.pid) - Number(right.pid))
  for (const panePid of panePids) {
    const queue = [...(children.get(panePid) || [])].map((entry) => ({ entry, depth: 1 }))
    let selected: { agent: string; direct: boolean; depth: number; pid: number } | null = null
    const visited = new Set<string>()
    while (queue.length) {
      const { entry, depth } = queue.shift()!
      if (visited.has(entry.pid)) continue
      visited.add(entry.pid)
      const agent = detect(entry.command)
      if (agent) {
        const executable = entry.command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop()?.toLowerCase() || ''
        const direct = !['node', 'bun', 'deno', 'python', 'python3'].includes(executable)
        const candidate = { agent, direct, depth, pid: Number(entry.pid) }
        if (!selected || Number(candidate.direct) > Number(selected.direct) || candidate.direct === selected.direct && (candidate.depth < selected.depth || candidate.depth === selected.depth && candidate.pid < selected.pid)) selected = candidate
      }
      queue.push(...(children.get(entry.pid) || []).map((child) => ({ entry: child, depth: depth + 1 })))
    }
    if (selected) agents.set(panePid, selected.agent)
  }
  return agents
}
