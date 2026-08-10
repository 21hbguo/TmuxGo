import { execFile } from 'child_process'
import { promisify } from 'util'
import * as pty from 'node-pty'
import { agentManager, type AgentTerminal } from '../agent-manager.js'
import { getHostById, getHostCredentials } from './hosts.js'
import { buildHostSshOptions, resolveHostPassword } from './ssh-options.js'

const execFileAsync = promisify(execFile)
let sshPassAvailable: boolean | null = null
export interface TerminalAttachment {
  pid: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (exitCode: number) => void) => void
}
export interface CreateTerminalAttachmentOptions {
  hostId: string
  sessionName: string
  cols: number
  rows: number
  exclusive: boolean
}
type PtySpawn = (file: string, args: string[], options: pty.IPtyForkOptions) => pty.IPty
let ptySpawn: PtySpawn = (file, args, options) => pty.spawn(file, args, options)
export function setPtySpawnForTest(spawn: PtySpawn) {
  ptySpawn = spawn
}
async function hasSshPass() {
  if (sshPassAvailable !== null) return sshPassAvailable
  try {
    await execFileAsync('sshpass', ['-V'])
    sshPassAvailable = true
  } catch {
    sshPassAvailable = false
  }
  return sshPassAvailable
}
function adaptAgentTerminal(terminal: AgentTerminal): TerminalAttachment {
  return {
    pid: terminal.pid,
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: () => terminal.kill(),
    onData: (listener) => terminal.onData(listener),
    onExit: (listener) => terminal.onExit((exitCode) => listener(exitCode)),
  }
}
function adaptPtyProcess(process: pty.IPty): TerminalAttachment {
  return {
    pid: process.pid,
    write: (data) => process.write(data),
    resize: (cols, rows) => process.resize(cols, rows),
    kill: () => process.kill(),
    onData: (listener) => {
      process.onData(listener)
    },
    onExit: (listener) => {
      process.onExit((event) => listener(event.exitCode))
    },
  }
}
export async function createTerminalAttachment(options: CreateTerminalAttachmentOptions): Promise<TerminalAttachment> {
  const { hostId, sessionName, cols, rows, exclusive } = options
  const agent = hostId !== 'local' && !(await getHostById(hostId)) ? agentManager.getAgent(hostId) : null
  if (agent) return adaptAgentTerminal(await agentManager.attachTerminal(hostId, sessionName, cols, rows, exclusive))
  if (hostId !== 'local') {
    const host = await getHostById(hostId)
    if (!host) throw new Error('Host not found')
    const credentials = await getHostCredentials(host.id)
    const target = `${host.user}@${host.address}`
    const sshBaseArgs = ['-p', String(host.port), '-tt', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', ...buildHostSshOptions(host, credentials), target, '--', host.tmuxPath || 'tmux', 'attach']
    if (!exclusive) sshBaseArgs.push('-f', 'ignore-size,active-pane')
    sshBaseArgs.push('-t', sessionName)
    const hostPassword = resolveHostPassword(credentials)
    if (hostPassword) {
      if (!(await hasSshPass())) throw new Error('sshpass is required for password auth')
      return adaptPtyProcess(ptySpawn('sshpass', ['-e', 'ssh', '-o', 'BatchMode=no', ...sshBaseArgs], {
        name: 'xterm-256color',
        cols,
        rows,
        env: { ...process.env, SSHPASS: hostPassword, TERM: 'xterm-256color' },
      }))
    }
    return adaptPtyProcess(ptySpawn('ssh', ['-o', 'BatchMode=yes', ...sshBaseArgs], {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' },
    }))
  }
  const attachArgs = ['attach']
  if (!exclusive) attachArgs.push('-f', 'ignore-size,active-pane')
  attachArgs.push('-t', sessionName)
  return adaptPtyProcess(ptySpawn('tmux', attachArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    env: { ...process.env, TERM: 'xterm-256color' },
  }))
}
