import { execFile } from 'child_process'
import { promisify } from 'util'
import { getHostById, getHostCredentials, type HostRecord } from './hosts.js'
import { recordHostConnectionFailure } from './host-connectivity.js'
import {
  buildHostSshOptions,
  buildSshConfigArgs,
  buildSshMultiplexArgs,
  buildSshPortArgs,
  ensureSshMultiplexDir,
  getSshTarget,
  resolveHostPassword,
} from './ssh-options.js'
import { agentManager } from '../agent-manager.js'

const execFileAsync = promisify(execFile)
const defaultTimeoutMs = 15000
const knownAuthMarkers = ['Permission denied']
const knownHostKeyMarkers = ['Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED']
const knownTimeoutMarkers = ['Connection timed out', 'Operation timed out', 'No route to host']
const knownNetworkMarkers = ['Could not resolve hostname', 'Connection refused', 'Network is unreachable']

export interface GitExecResult {
  stdout: string
  stderr: string
}

function escapeShellSingleQuoted(input: string) {
  return `'${input.replace(/'/g, `'\\''`)}'`
}

// execFile 失败的错误对象在 message 之外还挂 stdout/stderr/退出码；类型层只声明 Error，
// 这里按最小结构补齐（catch 值也可能是字符串，统一收窄）
interface ExecFileFailure extends Error {
  code?: number | string
  stdout?: string | Buffer
  stderr?: string | Buffer
}
function asExecFailure(err: unknown): ExecFileFailure | null {
  return err instanceof Error ? (err as ExecFileFailure) : null
}
function normalizeErrorMessage(raw: string, fallback: string) {
  const value = raw.trim() || fallback
  if (knownHostKeyMarkers.some((m) => value.includes(m))) return 'Host key verification failed'
  if (knownTimeoutMarkers.some((m) => value.includes(m))) return 'SSH connection timed out'
  if (knownNetworkMarkers.some((m) => value.includes(m))) return 'SSH network is unreachable'
  if (knownAuthMarkers.some((m) => value.includes(m))) return 'SSH authentication failed'
  return value
}
function reportRemoteError(host: HostRecord, raw: string, fallback: string) {
  const message = normalizeErrorMessage(raw, fallback)
  recordHostConnectionFailure(host.id, message)
  return new Error(message)
}

async function hasSshPass() {
  try {
    await execFileAsync('sshpass', ['-V'])
    return true
  } catch {
    return false
  }
}

async function runLocalGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  acceptExitCodeOne: boolean,
  signal?: AbortSignal,
) {
  try {
    return await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal })
  } catch (err) {
    const failure = asExecFailure(err)
    if (acceptExitCodeOne && failure?.code === 1)
      return { stdout: String(failure?.stdout || ''), stderr: String(failure?.stderr || '') }
    throw err
  }
}

async function runRemoteGit(
  host: HostRecord,
  args: string[],
  cwd: string,
  timeoutMs: number,
  acceptExitCodeOne: boolean,
  signal?: AbortSignal,
) {
  const remoteCommand = `cd ${escapeShellSingleQuoted(cwd)} && git ${args.map((a) => escapeShellSingleQuoted(a)).join(' ')}`
  const credentials = await getHostCredentials(host.id)
  const password = resolveHostPassword(credentials)
  await ensureSshMultiplexDir()
  const sshArgs = [
    ...(await buildSshConfigArgs(host)),
    ...buildSshPortArgs(host),
    '-o',
    'ConnectTimeout=8',
    '-o',
    `BatchMode=${password ? 'no' : 'yes'}`,
    ...buildSshMultiplexArgs(host),
    ...buildHostSshOptions(host, credentials),
    '-T',
    getSshTarget(host),
    '--',
    remoteCommand,
  ]
  if (password) {
    const canUseSshPass = await hasSshPass()
    if (!canUseSshPass) throw new Error('SSH password configured but sshpass is not installed')
    try {
      return await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], {
        timeout: timeoutMs,
        env: { ...process.env, SSHPASS: password },
        maxBuffer: 8 * 1024 * 1024,
        signal,
      })
    } catch (err) {
      const failure = asExecFailure(err)
      if (acceptExitCodeOne && failure?.code === 1)
        return { stdout: String(failure?.stdout || ''), stderr: String(failure?.stderr || '') }
      throw reportRemoteError(
        host,
        `${failure?.stderr || ''}\n${failure?.stdout || ''}`,
        failure?.message || 'SSH git command failed',
      )
    }
  }
  try {
    return await execFileAsync('ssh', sshArgs, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal })
  } catch (err) {
    const failure = asExecFailure(err)
    if (acceptExitCodeOne && failure?.code === 1)
      return { stdout: String(failure?.stdout || ''), stderr: String(failure?.stderr || '') }
    throw reportRemoteError(
      host,
      `${failure?.stderr || ''}\n${failure?.stdout || ''}`,
      failure?.message || 'SSH git command failed',
    )
  }
}

async function runAgentGit(hostId: string, args: string[], cwd: string, timeoutMs: number, acceptExitCodeOne: boolean) {
  const command = `cd ${escapeShellSingleQuoted(cwd)} && git ${args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')}`
  const result = await agentManager.executeShell(hostId, command, timeoutMs)
  if (result.exitCode === 0 || (acceptExitCodeOne && result.exitCode === 1))
    return { stdout: result.stdout, stderr: result.stderr }
  throw new Error(normalizeErrorMessage(`${result.stderr}\n${result.stdout}`, 'Agent git command failed'))
}

export async function execGit(
  hostIdRaw: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  acceptExitCodeOne = false,
  signal?: AbortSignal,
): Promise<GitExecResult> {
  const hostId = hostIdRaw.trim()
  if (!hostId) throw new Error('Missing host id')
  // agent 在线优先于 SSH 记录：双通道主机统一走 WS（与 tmux/attach/文件一致）
  const agent = agentManager.getAgent(hostId)
  const host = await getHostById(hostId)
  const timeout = timeoutMs || defaultTimeoutMs
  if (!host || agent?.online === true) {
    if (!agent) throw new Error(`Host "${hostId}" not found`)
    return runAgentGit(hostId, args, cwd, timeout, acceptExitCodeOne)
  }
  if (host.id === 'local') {
    try {
      const { stdout, stderr } = await runLocalGit(args, cwd, timeout, acceptExitCodeOne, signal)
      return { stdout, stderr }
    } catch (err) {
      const failure = asExecFailure(err)
      // git 把 merge/pull 的冲突报表写在 stdout（远端通道一直两者都拼，本机只拼 stderr 会让
      // 冲突分类落空）；这里与 reportRemoteError 保持一致，stdout 在前以便保留完整上下文
      const raw = `${failure?.stdout || ''}\n${failure?.stderr || ''}`.trim() || String(failure?.message || '')
      throw new Error(normalizeErrorMessage(raw, 'git command failed'), { cause: err })
    }
  }
  const { stdout, stderr } = await runRemoteGit(host, args, cwd, timeout, acceptExitCodeOne, signal)
  return { stdout, stderr }
}
