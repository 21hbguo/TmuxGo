import { execFile } from 'child_process'
import { promisify } from 'util'
import { getHostById, type HostRecord } from './hosts.js'

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

function resolveHostPassword(host: HostRecord) {
  if (host.password) return host.password
  const envName = host.passwordEnv.trim()
  if (!envName) return ''
  return process.env[envName] || ''
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

async function runLocalGit(args: string[], cwd: string, timeoutMs: number) {
  return execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
}

async function runRemoteGit(host: HostRecord, args: string[], cwd: string, timeoutMs: number) {
  const remoteCommand = `cd ${escapeShellSingleQuoted(cwd)} && git ${args.map((a) => escapeShellSingleQuoted(a)).join(' ')}`
  const sshArgs = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-T', `${host.user}@${host.address}`, '--', remoteCommand]
  const password = resolveHostPassword(host)
  if (password) {
    const canUseSshPass = await hasSshPass()
    if (!canUseSshPass) throw new Error('SSH password configured but sshpass is not installed')
    try {
      return await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], {
        timeout: timeoutMs,
        env: { ...process.env, SSHPASS: password },
        maxBuffer: 8 * 1024 * 1024,
      })
    } catch (err: any) {
      throw new Error(normalizeErrorMessage(`${err?.stderr || ''}\n${err?.stdout || ''}`, err?.message || 'SSH git command failed'))
    }
  }
  try {
    return await execFileAsync('ssh', sshArgs, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
  } catch (err: any) {
    throw new Error(normalizeErrorMessage(`${err?.stderr || ''}\n${err?.stdout || ''}`, err?.message || 'SSH git command failed'))
  }
}

export async function execGit(hostIdRaw: string, args: string[], cwd: string, timeoutMs?: number): Promise<GitExecResult> {
  const host = await getResolvedHost(hostIdRaw)
  const timeout = timeoutMs || defaultTimeoutMs
  if (host.id === 'local') {
    try {
      const { stdout, stderr } = await runLocalGit(args, cwd, timeout)
      return { stdout, stderr }
    } catch (err: any) {
      throw new Error(normalizeErrorMessage(String(err?.stderr || err?.message || ''), 'git command failed'))
    }
  }
  const { stdout, stderr } = await runRemoteGit(host, args, cwd, timeout)
  return { stdout, stderr }
}
