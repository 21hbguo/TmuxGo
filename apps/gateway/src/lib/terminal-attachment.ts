import { execFile } from 'child_process'
import { promisify } from 'util'
import * as pty from 'node-pty'
import { agentManager, type AgentTerminal } from '../agent-manager.js'
import { getHostById, getHostCredentials, type HostRecord } from './hosts.js'
import { execRemoteHostShell, quoteRemoteFileShellValue } from './remote-file-command.js'
import { isTmuxVersionAtLeast } from './security.js'
import {
  buildHostSshOptions,
  buildSshConfigArgs,
  buildSshMultiplexArgs,
  buildSshPortArgs,
  ensureSshMultiplexDir,
  getSshTarget,
  resolveHostPassword,
} from './ssh-options.js'

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
// attach -f ignore-size,active-pane 需要 tmux 3.2+；按 hostId 缓存探测结果，
// 远端升级 tmux 后需重启 gateway 才会重新探测
const attachFlagSupport = new Map<string, boolean>()
async function probeAttachFlagSupport(hostId: string, host: HostRecord | null) {
  const cached = attachFlagSupport.get(hostId)
  if (cached !== undefined) return cached
  // 探测失败（SSH 不可达/输出不可解析）维持原行为带 -f：反正 attach 也会失败，
  // 只有明确解析出 <3.2 版本才去掉该 flag
  let supported = true
  try {
    const stdout = host
      ? (await execRemoteHostShell(host, `${quoteRemoteFileShellValue(host.tmuxPath || 'tmux')} -V`)).stdout
      : String((await execFileAsync('tmux', ['-V'])).stdout)
    if (stdout.trim()) supported = isTmuxVersionAtLeast(stdout.trim(), 3, 2)
  } catch {}
  attachFlagSupport.set(hostId, supported)
  return supported
}
type AttachFlagProbe = (hostId: string, host: HostRecord | null) => Promise<boolean>
let attachFlagProbe: AttachFlagProbe = probeAttachFlagSupport
export function setAttachFlagProbeForTest(probe: AttachFlagProbe | null) {
  attachFlagProbe = probe || probeAttachFlagSupport
}
export async function createTerminalAttachment(options: CreateTerminalAttachmentOptions): Promise<TerminalAttachment> {
  const { hostId, sessionName, cols, rows, exclusive } = options
  // agent 在线优先于 SSH 记录：同一 host 双通道时统一走 WS（与 tmux/git/文件一致）
  const agent = hostId !== 'local' ? agentManager.getAgent(hostId) : null
  if (agent?.online === true)
    return adaptAgentTerminal(await agentManager.attachTerminal(hostId, sessionName, cols, rows, exclusive))
  if (hostId !== 'local') {
    const host = await getHostById(hostId)
    if (!host) throw new Error('Host not found')
    const credentials = await getHostCredentials(host.id)
    const target = getSshTarget(host)
    await ensureSshMultiplexDir()
    const sshBaseArgs = [
      ...(await buildSshConfigArgs(host)),
      ...buildSshPortArgs(host),
      '-tt',
      '-o',
      'ConnectTimeout=8',
      '-o',
      // 弱网跨主机：请求 SSH 链路压缩（server 不支持时安全回退）
      'Compression=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      ...buildSshMultiplexArgs(host),
      ...buildHostSshOptions(host, credentials),
      target,
      '--',
      host.tmuxPath || 'tmux',
      'attach',
    ]
    if (!exclusive && (await attachFlagProbe(hostId, host))) sshBaseArgs.push('-f', 'ignore-size,active-pane')
    sshBaseArgs.push('-t', sessionName)
    const hostPassword = resolveHostPassword(credentials)
    if (hostPassword) {
      if (!(await hasSshPass())) throw new Error('sshpass is required for password auth')
      return adaptPtyProcess(
        ptySpawn('sshpass', ['-e', 'ssh', '-o', 'BatchMode=no', ...sshBaseArgs], {
          name: 'xterm-256color',
          cols,
          rows,
          env: { ...process.env, SSHPASS: hostPassword, TERM: 'xterm-256color' },
        }),
      )
    }
    return adaptPtyProcess(
      ptySpawn('ssh', ['-o', 'BatchMode=yes', ...sshBaseArgs], {
        name: 'xterm-256color',
        cols,
        rows,
        env: { ...process.env, TERM: 'xterm-256color' },
      }),
    )
  }
  const attachArgs = ['attach']
  if (!exclusive && (await attachFlagProbe('local', null))) attachArgs.push('-f', 'ignore-size,active-pane')
  attachArgs.push('-t', sessionName)
  return adaptPtyProcess(
    ptySpawn('tmux', attachArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' },
    }),
  )
}
