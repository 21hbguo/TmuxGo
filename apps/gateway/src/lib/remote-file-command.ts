import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { getHostById, getHostCredentials, type HostRecord } from './hosts.js'
import { recordHostConnectionFailure } from './host-connectivity.js'
import { buildHostSshOptions, resolveHostPassword } from './ssh-options.js'
import { agentManager } from '../agent-manager.js'

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
  const agent=agentManager.getAgent(hostId)
  const remoteCommand = `python3 -c ${escapeShellSingleQuoted(script)} ${args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')}`
  if (agent) {
    const agentCommand=`python3 -c ${escapeShellSingleQuoted(`import base64;exec(base64.b64decode("${Buffer.from(script).toString('base64')}"))`)} ${args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')}`
    const result=await agentManager.executeShell(hostId,agentCommand,120000)
    if (result.exitCode!==0) throw new Error(normalizeRemoteFileErrorMessage(`${result.stderr}\n${result.stdout}`,'Agent file command failed'))
    return JSON.parse(result.stdout) as T
  }
  const host = await getRemoteFileHost(hostId)
  const credentials = await getHostCredentials(host.id)
  const password = resolveHostPassword(credentials)
  const sshArgs = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', `BatchMode=${password ? 'no' : 'yes'}`, ...buildHostSshOptions(host, credentials), '-T', `${host.user}@${host.address}`, '--', remoteCommand]
  try {
    if (password && !await hasSshPass()) throw new Error('SSH password configured but sshpass is not installed')
    const result = password
      ? await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], { env: { ...process.env, SSHPASS: password }, maxBuffer: 32 * 1024 * 1024 })
      : await execFileAsync('ssh', sshArgs, { maxBuffer: 32 * 1024 * 1024 })
    return JSON.parse(result.stdout) as T
  } catch (err: any) {
    const message = normalizeRemoteFileErrorMessage(`${err?.stderr || ''}\n${err?.stdout || ''}`, err?.message || 'SSH file command failed')
    recordHostConnectionFailure(host.id, message)
    throw new Error(message)
  }
}
export async function spawnRemoteFileCommand(host: HostRecord, remoteCommand: string, signal?: AbortSignal) {
  const credentials = await getHostCredentials(host.id)
  const password = resolveHostPassword(credentials)
  const sshArgs = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', `BatchMode=${password ? 'no' : 'yes'}`, ...buildHostSshOptions(host, credentials), '-T', `${host.user}@${host.address}`, '--', remoteCommand]
  let child
  if (password) {
    if (!await hasSshPass()) throw new Error('SSH password configured but sshpass is not installed')
    child=spawn('sshpass', ['-e', 'ssh', ...sshArgs], { env: { ...process.env, SSHPASS: password }, stdio: ['pipe', 'pipe', 'pipe'] })
  } else {
    child=spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
  }
  if (!signal) return child
  const abort=()=>child.kill('SIGTERM')
  if (signal.aborted) abort()
  else signal.addEventListener('abort',abort,{once:true})
  child.once('close',()=>signal.removeEventListener('abort',abort))
  return child
}
export function quoteRemoteFileShellValue(value: string) {
  return escapeShellSingleQuoted(value)
}
