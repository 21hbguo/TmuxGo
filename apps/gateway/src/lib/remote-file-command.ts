import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { getHostById, type HostRecord } from './hosts.js'

const execFileAsync = promisify(execFile)
const knownAuthMarkers = ['Permission denied']
const knownHostKeyMarkers = ['Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED']
const knownTimeoutMarkers = ['Connection timed out', 'Operation timed out', 'No route to host']
const knownNetworkMarkers = ['Could not resolve hostname', 'Connection refused', 'Network is unreachable']

function escapeShellSingleQuoted(input: string) {
  return `'${input.replace(/'/g, `'\\''`)}'`
}
export function normalizeRemoteFileErrorMessage(raw: string, fallback: string) {
  const value = raw.trim() || fallback
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
async function hasSshPass() {
  try {
    await execFileAsync('sshpass', ['-V'])
    return true
  } catch {
    return false
  }
}
export async function getRemoteFileHost(hostIdRaw: string) {
  const hostId = hostIdRaw.trim()
  if (!hostId) throw new Error('Missing host id')
  const host = await getHostById(hostId)
  if (!host) throw new Error(`Host "${hostId}" not found`)
  return host
}
export async function runRemoteFilePython<T>(hostId: string, script: string, args: string[]): Promise<T> {
  const host = await getRemoteFileHost(hostId)
  const remoteCommand = `python3 -c ${escapeShellSingleQuoted(script)} -- ${args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')}`
  const sshArgs = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-T', `${host.user}@${host.address}`, '--', remoteCommand]
  const password = resolveHostPassword(host)
  try {
    if (password && !await hasSshPass()) throw new Error('SSH password configured but sshpass is not installed')
    const result = password
      ? await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], { env: { ...process.env, SSHPASS: password }, maxBuffer: 32 * 1024 * 1024 })
      : await execFileAsync('ssh', sshArgs, { maxBuffer: 32 * 1024 * 1024 })
    return JSON.parse(result.stdout) as T
  } catch (err: any) {
    throw new Error(normalizeRemoteFileErrorMessage(`${err?.stderr || ''}\n${err?.stdout || ''}`, err?.message || 'SSH file command failed'))
  }
}
export async function spawnRemoteFileCommand(host: HostRecord, remoteCommand: string) {
  const sshArgs = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-T', `${host.user}@${host.address}`, '--', remoteCommand]
  const password = resolveHostPassword(host)
  if (password) {
    if (!await hasSshPass()) throw new Error('SSH password configured but sshpass is not installed')
    return spawn('sshpass', ['-e', 'ssh', ...sshArgs], { env: { ...process.env, SSHPASS: password }, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  return spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
}
export function quoteRemoteFileShellValue(value: string) {
  return escapeShellSingleQuoted(value)
}
