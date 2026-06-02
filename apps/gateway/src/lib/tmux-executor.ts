import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { getHostById, type HostRecord } from './hosts.js'

const execFileAsync = promisify(execFile)
const defaultTimeoutMs = 30000
const sshCheckTimeoutMs = 5000
const sshReadyTimeoutMs = 12000
const knownAuthMarkers = ['Permission denied', 'Permission denied (publickey', 'Permission denied (publickey,password', 'Permission denied (password']
const knownHostKeyMarkers = ['Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED', 'fingerprint']
const knownTimeoutMarkers = ['Connection timed out', 'Operation timed out', 'No route to host']
const knownNetworkMarkers = ['Could not resolve hostname', 'Connection refused', 'Network is unreachable']
const knownMissingTmuxMarkers = ['tmux: command not found']
const sshMultiplexDir = path.join(os.tmpdir(), 'tmuxgo-ssh')
function getControlPath(host: HostRecord) {
  return path.join(sshMultiplexDir, `${host.user}@${host.address}:${host.port}`)
}
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
function toHostAddress(host: HostRecord) {
  return `${host.user}@${host.address}`
}
function normalizeErrorMessage(raw: string, fallback: string) {
  const value = raw.trim() || fallback
  if (knownMissingTmuxMarkers.some((marker) => value.includes(marker))) return 'tmux is not installed on target host'
  if (knownHostKeyMarkers.some((marker) => value.includes(marker))) return 'Host key verification failed'
  if (knownTimeoutMarkers.some((marker) => value.includes(marker))) return 'SSH connection timed out'
  if (knownNetworkMarkers.some((marker) => value.includes(marker))) return 'SSH network is unreachable'
  if (knownAuthMarkers.some((marker) => value.includes(marker))) return 'SSH authentication failed'
  return value
}
function resolveHostPassword(host: HostRecord) {
  if (host.password) return host.password
  const envName = host.passwordEnv.trim()
  if (!envName) return ''
  return process.env[envName] || ''
}
function buildPasswordEnv(host: HostRecord) {
  const password = resolveHostPassword(host)
  if (!password) return null
  return {
    SSHPASS: password,
  }
}
async function hasSshPass() {
  try {
    await execFileAsync('sshpass', ['-V'])
    return true
  } catch {
    return false
  }
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
function buildSshArgs(host: HostRecord, remoteCommand: string, options: TmuxExecOptions = {}, usePassword = false) {
  const args: string[] = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3']
  const controlPath = getControlPath(host)
  args.push('-o', `ControlPath=${controlPath}`)
  args.push('-o', 'ControlMaster=auto')
  args.push('-o', 'ControlPersist=600')
  if (usePassword) {
    args.push('-o', 'BatchMode=no')
  } else if (options.mode === 'json' || options.allowPrompt !== true) {
    args.push('-o', 'BatchMode=yes')
  }
  args.push('-o', 'StrictHostKeyChecking=accept-new')
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
  const { stdout, stderr } = await execFileAsync('tmux', args, { timeout: options.timeoutMs || defaultTimeoutMs, maxBuffer: 8 * 1024 * 1024 })
  return { stdout, stderr }
}
async function runLocalShell(command: string, options: TmuxExecOptions = {}) {
  const { stdout, stderr } = await execFileAsync('sh', ['-lc', command], { timeout: options.timeoutMs || defaultTimeoutMs, maxBuffer: 8 * 1024 * 1024 })
  return { stdout, stderr }
}
async function runRemoteTmux(host: HostRecord, args: string[], options: TmuxExecOptions = {}) {
  await ensureMultiplexDir()
  const remoteCommand = `tmux ${args.map((item) => escapeShellSingleQuoted(item)).join(' ')}`
  const passwordEnv = buildPasswordEnv(host)
  const hasPassword = !!passwordEnv
  const canUseSshPass = hasPassword && await hasSshPass()
  const sshArgs = buildSshArgs(host, remoteCommand, options, canUseSshPass)
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
      throw new Error(normalizeErrorMessage(`${stderr}\n${stdout}`, err?.message || 'SSH command failed'))
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
    throw new Error(normalizeErrorMessage(`${stderr}\n${stdout}`, err?.message || 'SSH command failed'))
  }
}
async function runRemoteShell(host: HostRecord, command: string, options: TmuxExecOptions = {}) {
  await ensureMultiplexDir()
  const passwordEnv = buildPasswordEnv(host)
  const hasPassword = !!passwordEnv
  const canUseSshPass = hasPassword && await hasSshPass()
  const sshArgs = buildSshArgs(host, `sh -lc ${escapeShellSingleQuoted(command)}`, options, canUseSshPass)
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
      throw new Error(normalizeErrorMessage(`${stderr}\n${stdout}`, err?.message || 'SSH command failed'))
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
    throw new Error(normalizeErrorMessage(`${stderr}\n${stdout}`, err?.message || 'SSH command failed'))
  }
}
export async function execTmux(hostIdRaw: string, args: string[], options: TmuxExecOptions = {}): Promise<TmuxExecResult> {
  const host = await getResolvedHost(hostIdRaw)
  if (host.id === 'local') {
    try {
      const result = await runLocalTmux(args, options)
      return { ...result, host }
    } catch (err: any) {
      throw new Error(normalizeErrorMessage(String(err?.stderr || err?.message || ''), 'tmux command failed'))
    }
  }
  const result = await runRemoteTmux(host, args, options)
  return { ...result, host }
}
export async function execHostShell(hostIdRaw: string, command: string, options: TmuxExecOptions = {}): Promise<TmuxExecResult> {
  const host = await getResolvedHost(hostIdRaw)
  if (host.id === 'local') {
    try {
      const result = await runLocalShell(command, options)
      return { ...result, host }
    } catch (err: any) {
      throw new Error(normalizeErrorMessage(String(err?.stderr || err?.message || ''), 'shell command failed'))
    }
  }
  const result = await runRemoteShell(host, command, options)
  return { ...result, host }
}
function extractErrorSummary(stderr: string, stdout: string, fallback: string) {
  return normalizeErrorMessage(`${stderr}\n${stdout}`, fallback)
}
async function ensureMultiplexDir() {
  await fs.mkdir(sshMultiplexDir, { recursive: true, mode: 0o700 })
}

export async function cleanupMultiplexSockets() {
  try {
    await fs.rm(sshMultiplexDir, { recursive: true, force: true })
  } catch {}
}

export async function verifyHostConnectivity(hostIdRaw: string) {
  const host = await getResolvedHost(hostIdRaw)
  const passwordEnv = buildPasswordEnv(host)
  const sshPassAvailable = await hasSshPass()
  if (passwordEnv && !sshPassAvailable) {
    return { ok: false, message: 'sshpass is required for password auth', mode: 'password' as const }
  }
  if (host.id === 'local') {
    return { ok: true, message: 'local host available', mode: 'local' as const }
  }
  await ensureMultiplexDir()
  const controlPath = getControlPath(host)
  const checkArgs = ['-p', String(host.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', '-o', `ControlPath=${controlPath}`, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=600', '-T', toHostAddress(host), '--', 'echo', 'tmuxgo-ok']
  const tryPassword = async () => {
    if (!passwordEnv) return null
    try {
      const { stdout } = await execFileAsync('sshpass', ['-e', 'ssh', '-p', String(host.port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-T', toHostAddress(host), '--', 'echo', 'tmuxgo-ok'], {
        timeout: sshReadyTimeoutMs,
        env: { ...process.env, ...passwordEnv },
        maxBuffer: 1024 * 1024,
      })
      const ok = stdout.trim() === 'tmuxgo-ok'
      if (ok) return { ok: true, message: 'ssh ready', mode: 'password' as const }
      return { ok: false, message: 'SSH authentication failed', mode: 'password' as const }
    } catch (err: any) {
      const stderr = String(err?.stderr || '')
      const stdout = String(err?.stdout || '')
      return { ok: false, message: extractErrorSummary(stderr, stdout, err?.message || 'ssh password validation failed'), mode: 'password' as const }
    }
  }
  try {
    const { stdout } = await execFileAsync('ssh', checkArgs, { timeout: sshCheckTimeoutMs, maxBuffer: 1024 * 1024 })
    const ok = stdout.trim() === 'tmuxgo-ok'
    if (ok) return { ok: true, message: 'ssh ready', mode: 'key' as const }
  } catch (err: any) {
    const stderr = String(err?.stderr || '')
    const stdout = String(err?.stdout || '')
    const normalized = extractErrorSummary(stderr, stdout, err?.message || 'ssh validation failed')
    const passwordResult = await tryPassword()
    if (passwordResult) return passwordResult
    return { ok: false, message: normalized, mode: 'key' as const }
  }
  const passwordResult = await tryPassword()
  if (passwordResult) return passwordResult
  return { ok: false, message: 'SSH authentication failed', mode: 'key' as const }
}
