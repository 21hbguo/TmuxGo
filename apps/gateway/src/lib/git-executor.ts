import { execFile } from 'child_process'
import { promisify } from 'util'
import { getHostById, getHostCredentials, type HostRecord } from './hosts.js'
import { recordHostConnectionFailure } from './host-connectivity.js'
import { buildHostSshOptions, resolveHostPassword } from './ssh-options.js'

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

async function getResolvedHost(hostIdRaw: string) {
  const hostId = hostIdRaw.trim()
  if (!hostId) throw new Error('Missing host id')
  const host = await getHostById(hostId)
  if (!host) throw new Error(`Host "${hostId}" not found`)
  return host
}

async function runLocalGit(args: string[], cwd: string, timeoutMs: number, acceptExitCodeOne: boolean, signal?: AbortSignal) {
  try {
    return await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal })
  } catch (err: any) {
    if (acceptExitCodeOne && err?.code === 1) return { stdout: String(err?.stdout || ''), stderr: String(err?.stderr || '') }
    throw err
  }
}

async function runRemoteGit(host: HostRecord, args: string[], cwd: string, timeoutMs: number, acceptExitCodeOne: boolean, signal?: AbortSignal) {
  const remoteCommand = `cd ${escapeShellSingleQuoted(cwd)} && git ${args.map((a) => escapeShellSingleQuoted(a)).join(' ')}`
  const credentials = await getHostCredentials(host.id)
  const password = resolveHostPassword(credentials)
  const sshArgs = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', `BatchMode=${password ? 'no' : 'yes'}`, ...buildHostSshOptions(host, credentials), '-T', `${host.user}@${host.address}`, '--', remoteCommand]
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
    } catch (err: any) {
      if (acceptExitCodeOne && err?.code === 1) return { stdout: String(err?.stdout || ''), stderr: String(err?.stderr || '') }
      throw reportRemoteError(host, `${err?.stderr || ''}\n${err?.stdout || ''}`, err?.message || 'SSH git command failed')
    }
  }
  try {
    return await execFileAsync('ssh', sshArgs, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal })
  } catch (err: any) {
    if (acceptExitCodeOne && err?.code === 1) return { stdout: String(err?.stdout || ''), stderr: String(err?.stderr || '') }
    throw reportRemoteError(host, `${err?.stderr || ''}\n${err?.stdout || ''}`, err?.message || 'SSH git command failed')
  }
}

export async function execGit(hostIdRaw: string, args: string[], cwd: string, timeoutMs?: number, acceptExitCodeOne = false, signal?: AbortSignal): Promise<GitExecResult> {
  const host = await getResolvedHost(hostIdRaw)
  const timeout = timeoutMs || defaultTimeoutMs
  if (host.id === 'local') {
    try {
      const { stdout, stderr } = await runLocalGit(args, cwd, timeout, acceptExitCodeOne, signal)
      return { stdout, stderr }
    } catch (err: any) {
      throw new Error(normalizeErrorMessage(String(err?.stderr || err?.message || ''), 'git command failed'))
    }
  }
  const { stdout, stderr } = await runRemoteGit(host, args, cwd, timeout, acceptExitCodeOne, signal)
  return { stdout, stderr }
}
