import { execFile, spawn } from 'child_process'
import net from 'net'
import { promisify } from 'util'
import { getHostById, getHostCredentials, type HostCredentials, type HostRecord } from './hosts.js'
import { recordHostConnectionFailure } from './host-connectivity.js'
import {
  buildHostSshOptions,
  buildSshConfigArgs,
  buildSshMultiplexArgs,
  buildSshPortArgs,
  cleanupSshMultiplexSockets,
  ensureSshMultiplexDir,
  getSshTarget,
  resolveHostPassword,
} from './ssh-options.js'
import { agentManager, type AgentStatus } from '../agent-manager.js'
import { getTmuxEnvEntries } from './tmux-env.js'

const execFileAsync = promisify(execFile)
const defaultTimeoutMs = 30000
const sshCheckTimeoutMs = 5000
const sshReadyTimeoutMs = 12000
let sshPassAvailable: boolean | null = null
const knownAuthMarkers = [
  'Permission denied',
  'Permission denied (publickey',
  'Permission denied (publickey,password',
  'Permission denied (password',
]
const knownHostKeyMarkers = ['Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED', 'fingerprint']
const knownTimeoutMarkers = ['Connection timed out', 'Operation timed out', 'No route to host']
const knownNetworkMarkers = ['Could not resolve hostname', 'Connection refused', 'Network is unreachable']
const knownMissingTmuxMarkers = ['tmux: command not found']
const knownPrivateKeyMarkers = ['identity file', 'Load key']

export type TmuxExecMode = 'json' | 'plain'
export interface TmuxExecOptions {
  mode?: TmuxExecMode
  timeoutMs?: number
  allowPrompt?: boolean
  needsPty?: boolean
}
export interface TmuxExecResult {
  stdout: string
  stderr: string
  host: HostRecord
}
function escapeShellSingleQuoted(input: string) {
  return `'${input.replace(/'/g, `'\\''`)}'`
}
export function normalizeTmuxEnvArgs(args: string[]) {
  const result: string[] = []
  let needsSetEnv = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && args[i + 1] === 'TMUXGO_ENV=1') {
      needsSetEnv = true
      i++
      continue
    }
    result.push(args[i])
  }
  return { args: result, needsSetEnv }
}
// 创建命令触发 setenv 时补齐全套 TMUXGO_*（token/gateway url），
// agent 在 pane 里回调 control plane 免手工 export
async function applyTmuxGoEnv(hostIdRaw: string, options: TmuxExecOptions) {
  for (const entry of getTmuxEnvEntries(hostIdRaw)) {
    const sep = entry.indexOf('=')
    await execTmux(hostIdRaw, ['setenv', '-g', entry.slice(0, sep), entry.slice(sep + 1)], options)
  }
}
function toHostAddress(host: HostRecord) {
  return getSshTarget(host)
}
function normalizeErrorMessage(raw: string, fallback: string) {
  const value = raw.trim() || fallback
  if (knownMissingTmuxMarkers.some((marker) => value.includes(marker))) return 'tmux is not installed on target host'
  if (knownHostKeyMarkers.some((marker) => value.includes(marker))) return 'Host key verification failed'
  if (knownTimeoutMarkers.some((marker) => value.includes(marker))) return 'SSH connection timed out'
  if (knownNetworkMarkers.some((marker) => value.includes(marker))) return 'SSH network is unreachable'
  if (knownAuthMarkers.some((marker) => value.includes(marker))) return 'SSH authentication failed'
  if (knownPrivateKeyMarkers.some((marker) => value.includes(marker))) return 'SSH private key is unavailable'
  return value
}
function reportRemoteError(host: HostRecord, stderr: string, stdout: string, fallback: string) {
  const message = normalizeErrorMessage(`${stderr}\n${stdout}`, fallback)
  recordHostConnectionFailure(host.id, message)
  return new Error(message)
}
function buildPasswordEnv(credentials: HostCredentials) {
  const password = resolveHostPassword(credentials)
  if (!password) return null
  return {
    SSHPASS: password,
  }
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
function parseHostInput(hostIdRaw: string) {
  const hostId = hostIdRaw.trim()
  if (!hostId) throw new Error('Missing host id')
  return hostId
}
async function getResolvedHost(hostIdRaw: string) {
  const hostId = parseHostInput(hostIdRaw)
  const host = await getHostById(hostId)
  if (!host) throw new Error(`Host "${hostId}" not found`)
  return host
}
function toAgentHost(agent: AgentStatus): HostRecord {
  return {
    id: agent.id,
    name: agent.name,
    address: agent.address,
    user: '',
    port: 22,
    auth: 'auto',
    groups: [],
    tags: [],
    favorite: false,
    useAgent: true,
    jumpHost: '',
    knownHostsPolicy: 'strict',
    tmuxPath: '',
    createdAt: agent.connectedAt || agent.lastSeenAt,
    updatedAt: agent.lastSeenAt,
  }
}
async function buildSshArgs(
  host: HostRecord,
  remoteCommand: string,
  options: TmuxExecOptions = {},
  usePassword = false,
  credentials: HostCredentials,
) {
  const args: string[] = [
    ...(await buildSshConfigArgs(host)),
    ...buildSshPortArgs(host),
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
  ]
  args.push(...buildSshMultiplexArgs(host))
  if (usePassword) {
    args.push('-o', 'BatchMode=no')
  } else if (options.mode === 'json' || options.allowPrompt !== true) {
    args.push('-o', 'BatchMode=yes')
  }
  args.push(...buildHostSshOptions(host, credentials))
  if (options.needsPty === true) {
    args.push('-tt')
  } else {
    args.push('-T')
  }
  args.push(toHostAddress(host))
  args.push('--')
  args.push(remoteCommand)
  return args
}
async function runLocalTmux(args: string[], options: TmuxExecOptions = {}) {
  const useSystemdScope = args[0] === 'new-session' && !!process.env.INVOCATION_ID
  const command = useSystemdScope ? 'systemd-run' : 'tmux'
  const commandArgs = useSystemdScope ? ['--user', '--scope', '--quiet', '--collect', 'tmux', ...args] : args
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    timeout: options.timeoutMs || defaultTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { stdout, stderr }
}
async function runLocalShell(command: string, options: TmuxExecOptions = {}) {
  const { stdout, stderr } = await execFileAsync('sh', ['-lc', command], {
    timeout: options.timeoutMs || defaultTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { stdout, stderr }
}
async function runRemoteTmux(host: HostRecord, args: string[], options: TmuxExecOptions = {}) {
  await ensureSshMultiplexDir()
  const remoteCommand = `${escapeShellSingleQuoted(host.tmuxPath || 'tmux')} ${args.map((item) => escapeShellSingleQuoted(item)).join(' ')}`
  const credentials = await getHostCredentials(host.id)
  const passwordEnv = buildPasswordEnv(credentials)
  const hasPassword = !!passwordEnv
  const canUseSshPass = hasPassword && (await hasSshPass())
  const sshArgs = await buildSshArgs(host, remoteCommand, options, canUseSshPass, credentials)
  if (canUseSshPass) {
    try {
      const { stdout, stderr } = await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], {
        timeout: options.timeoutMs || defaultTimeoutMs,
        env: { ...process.env, ...passwordEnv },
        maxBuffer: 8 * 1024 * 1024,
      })
      return { stdout, stderr }
    } catch (err: any) {
      const stderr = String(err?.stderr || '')
      const stdout = String(err?.stdout || '')
      throw reportRemoteError(host, stderr, stdout, err?.message || 'SSH command failed')
    }
  }
  if (hasPassword && !canUseSshPass) {
    throw new Error('SSH password env configured but sshpass is not installed')
  }
  try {
    const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
      timeout: options.timeoutMs || defaultTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (err: any) {
    const stderr = String(err?.stderr || '')
    const stdout = String(err?.stdout || '')
    throw reportRemoteError(host, stderr, stdout, err?.message || 'SSH command failed')
  }
}
async function runRemoteShell(host: HostRecord, command: string, options: TmuxExecOptions = {}) {
  await ensureSshMultiplexDir()
  const credentials = await getHostCredentials(host.id)
  const passwordEnv = buildPasswordEnv(credentials)
  const hasPassword = !!passwordEnv
  const canUseSshPass = hasPassword && (await hasSshPass())
  const sshArgs = await buildSshArgs(
    host,
    `sh -lc ${escapeShellSingleQuoted(command)}`,
    options,
    canUseSshPass,
    credentials,
  )
  if (canUseSshPass) {
    try {
      const { stdout, stderr } = await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], {
        timeout: options.timeoutMs || defaultTimeoutMs,
        env: { ...process.env, ...passwordEnv },
        maxBuffer: 8 * 1024 * 1024,
      })
      return { stdout, stderr }
    } catch (err: any) {
      const stderr = String(err?.stderr || '')
      const stdout = String(err?.stdout || '')
      throw reportRemoteError(host, stderr, stdout, err?.message || 'SSH command failed')
    }
  }
  if (hasPassword && !canUseSshPass) {
    throw new Error('SSH password env configured but sshpass is not installed')
  }
  try {
    const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
      timeout: options.timeoutMs || defaultTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (err: any) {
    const stderr = String(err?.stderr || '')
    const stdout = String(err?.stdout || '')
    throw reportRemoteError(host, stderr, stdout, err?.message || 'SSH command failed')
  }
}
function isTmuxServerMissingError(message: string) {
  const value = message.toLowerCase()
  return (
    value.includes('error connecting to') ||
    value.includes('no server running') ||
    value.includes('failed to connect to server')
  )
}
export async function execTmux(
  hostIdRaw: string,
  args: string[],
  options: TmuxExecOptions = {},
): Promise<TmuxExecResult> {
  const normalized = normalizeTmuxEnvArgs(args)
  let deferSetEnv = false
  if (normalized.needsSetEnv) {
    try {
      await applyTmuxGoEnv(hostIdRaw, options)
    } catch (err: any) {
      if (!isTmuxServerMissingError(String(err?.message || ''))) throw err
      deferSetEnv = true
    }
  }
  args = normalized.args
  const hostId = parseHostInput(hostIdRaw)
  const host = await getHostById(hostId)
  if (!host) {
    const agent = agentManager.getAgent(hostId)
    if (!agent) throw new Error(`Host "${hostId}" not found`)
    const result = await agentManager.executeTmux(hostId, args, options.timeoutMs || defaultTimeoutMs)
    await retrySetEnvIfNeeded(deferSetEnv, hostId)
    return { ...result, host: toAgentHost(agent) }
  }
  if (host.id === 'local') {
    try {
      const result = await runLocalTmux(args, options)
      await retrySetEnvIfNeeded(deferSetEnv, hostId)
      return { ...result, host }
    } catch (err: any) {
      throw new Error(normalizeErrorMessage(String(err?.stderr || err?.message || ''), 'tmux command failed'), {
        cause: err,
      })
    }
  }
  const result = await runRemoteTmux(host, args, options)
  await retrySetEnvIfNeeded(deferSetEnv, hostId)
  return { ...result, host }
}
async function retrySetEnvIfNeeded(deferSetEnv: boolean, hostIdRaw: string) {
  if (!deferSetEnv) return
  try {
    await applyTmuxGoEnv(hostIdRaw, {})
  } catch {
    // setenv 是尽力而为的环境标记，失败不影响主流程
  }
}
export async function execHostShell(
  hostIdRaw: string,
  command: string,
  options: TmuxExecOptions = {},
): Promise<TmuxExecResult> {
  const hostId = parseHostInput(hostIdRaw)
  const host = await getHostById(hostId)
  if (!host) {
    const agent = agentManager.getAgent(hostId)
    if (!agent) throw new Error(`Host "${hostId}" not found`)
    const result = await agentManager.executeShell(hostId, command, options.timeoutMs || defaultTimeoutMs)
    if (result.exitCode !== 0)
      throw new Error(normalizeErrorMessage(`${result.stderr}\n${result.stdout}`, 'Agent shell command failed'))
    return { stdout: result.stdout, stderr: result.stderr, host: toAgentHost(agent) }
  }
  if (host.id === 'local') {
    try {
      const result = await runLocalShell(command, options)
      return { ...result, host }
    } catch (err: any) {
      throw new Error(normalizeErrorMessage(String(err?.stderr || err?.message || ''), 'shell command failed'), {
        cause: err,
      })
    }
  }
  const result = await runRemoteShell(host, command, options)
  return { ...result, host }
}
// SSH 隧道兜底：agent 不在线的远端主机经 `ssh -L` 把远端 loopback VNC 映到 gateway 本机端口。
// 刻意不用 ControlMaster 多路复用：挂到共享 master 的 -L 转发会随 master 生命周期泄漏，
// 隧道用独立 ssh 进程，断连时直接 SIGTERM。
export interface VncSshTunnel {
  localPort: number
  close: () => void
}
export async function pickFreeLoopbackPort(min = 5940, max = 5999): Promise<number | null> {
  for (let port = min; port <= max; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, '127.0.0.1')
    })
    if (ok) return port
  }
  return null
}
export async function openVncSshTunnel(hostIdRaw: string, remotePort: number): Promise<VncSshTunnel> {
  const host = await getResolvedHost(hostIdRaw)
  // sshconfig 主机允许 user/address 为空（由 config 解析）；store 主机仍需完整连接参数
  if (host.id === 'local' || (host.source !== 'sshconfig' && (!host.user || !host.address)))
    throw new Error('Host has no SSH target configured')
  const localPort = await pickFreeLoopbackPort()
  if (!localPort) throw new Error('No free loopback port for SSH tunnel')
  const credentials = await getHostCredentials(host.id)
  const passwordEnv = buildPasswordEnv(credentials)
  const canUseSshPass = !!passwordEnv && (await hasSshPass())
  if (passwordEnv && !canUseSshPass) throw new Error('SSH password env configured but sshpass is not installed')
  const args = [
    '-N',
    '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ...(await buildSshConfigArgs(host)),
    ...buildSshPortArgs(host),
    ...buildHostSshOptions(host, credentials),
    ...(canUseSshPass ? [] : ['-o', 'BatchMode=yes']),
    toHostAddress(host),
  ]
  const child = canUseSshPass
    ? spawn('sshpass', ['-e', 'ssh', ...args], {
        env: { ...process.env, ...passwordEnv },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    : spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  let spawnFailed = false
  child.once('error', () => {
    spawnFailed = true
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const close = () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }
  // 等隧道就绪：轮询本机转发端口直到接受 TCP 连接；ssh 提前退出即视为失败
  const deadline = Date.now() + sshReadyTimeoutMs
  while (Date.now() < deadline) {
    if (spawnFailed || child.exitCode !== null || child.signalCode !== null) break
    const up = await new Promise<boolean>((resolve) => {
      const probe = net.connect({ host: '127.0.0.1', port: localPort })
      probe.once('connect', () => {
        probe.destroy()
        resolve(true)
      })
      probe.once('error', () => resolve(false))
      probe.setTimeout(500, () => {
        probe.destroy()
        resolve(false)
      })
    })
    if (up) return { localPort, close }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  close()
  throw new Error(normalizeErrorMessage(stderr, 'SSH tunnel failed'))
}

function extractErrorSummary(stderr: string, stdout: string, fallback: string) {
  return normalizeErrorMessage(`${stderr}\n${stdout}`, fallback)
}
function getConnectionErrorCode(message: string) {
  if (message === 'Host key verification failed') return 'HOST_KEY_ERROR'
  if (message === 'SSH authentication failed' || message === 'SSH private key is unavailable')
    return 'AUTHENTICATION_ERROR'
  if (message === 'SSH connection timed out' || message === 'SSH network is unreachable') return 'NETWORK_ERROR'
  return 'CONNECTION_ERROR'
}
export const cleanupMultiplexSockets = cleanupSshMultiplexSockets

export async function verifyHostConnectivity(hostIdRaw: string) {
  const hostId = parseHostInput(hostIdRaw)
  const host = await getHostById(hostId)
  if (!host) {
    const agent = agentManager.getAgent(hostId)
    if (agent) return { ok: true, message: 'agent ready', mode: 'agent' as const }
    throw new Error(`Host "${hostId}" not found`)
  }
  const credentials = await getHostCredentials(host.id)
  const passwordEnv = buildPasswordEnv(credentials)
  const sshPassAvailable = await hasSshPass()
  if (passwordEnv && !sshPassAvailable) {
    return {
      ok: false,
      message: 'sshpass is required for password auth',
      mode: 'password' as const,
      code: 'AUTHENTICATION_ERROR' as const,
    }
  }
  if (host.id === 'local') {
    return { ok: true, message: 'local host available', mode: 'local' as const }
  }
  await ensureSshMultiplexDir()
  const checkArgs = await buildSshArgs(host, 'echo tmuxgo-ok', { mode: 'json' }, false, credentials)
  const tryPassword = async () => {
    if (!passwordEnv) return null
    try {
      const { stdout } = await execFileAsync(
        'sshpass',
        ['-e', 'ssh', ...(await buildSshArgs(host, 'echo tmuxgo-ok', {}, true, credentials))],
        {
          timeout: sshReadyTimeoutMs,
          env: { ...process.env, ...passwordEnv },
          maxBuffer: 1024 * 1024,
        },
      )
      const ok = stdout.trim() === 'tmuxgo-ok'
      if (ok) return { ok: true, message: 'ssh ready', mode: 'password' as const }
      return {
        ok: false,
        message: 'SSH authentication failed',
        mode: 'password' as const,
        code: 'AUTHENTICATION_ERROR' as const,
      }
    } catch (err: any) {
      const stderr = String(err?.stderr || '')
      const stdout = String(err?.stdout || '')
      const message = extractErrorSummary(stderr, stdout, err?.message || 'ssh password validation failed')
      return { ok: false, message, mode: 'password' as const, code: getConnectionErrorCode(message) }
    }
  }
  try {
    const { stdout } = await execFileAsync('ssh', checkArgs, { timeout: sshCheckTimeoutMs, maxBuffer: 1024 * 1024 })
    const ok = stdout.trim() === 'tmuxgo-ok'
    if (ok)
      return {
        ok: true,
        message: 'ssh ready',
        mode:
          credentials.privateKeyPath || host.identityFile
            ? ('key' as const)
            : host.useAgent
              ? ('agent' as const)
              : ('key' as const),
      }
  } catch (err: any) {
    const stderr = String(err?.stderr || '')
    const stdout = String(err?.stdout || '')
    const normalized = extractErrorSummary(stderr, stdout, err?.message || 'ssh validation failed')
    const passwordResult = await tryPassword()
    if (passwordResult) return passwordResult
    return {
      ok: false,
      message: normalized,
      mode:
        credentials.privateKeyPath || host.identityFile
          ? ('key' as const)
          : host.useAgent
            ? ('agent' as const)
            : ('key' as const),
      code: getConnectionErrorCode(normalized),
    }
  }
  const passwordResult = await tryPassword()
  if (passwordResult) return passwordResult
  return {
    ok: false,
    message: 'SSH authentication failed',
    mode:
      credentials.privateKeyPath || host.identityFile
        ? ('key' as const)
        : host.useAgent
          ? ('agent' as const)
          : ('key' as const),
    code: 'AUTHENTICATION_ERROR' as const,
  }
}
