import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const RECOMMENDED_TMUX_VERSION = '3.6b'
const execFileAsync = promisify(execFile)

type TmuxVersion = { major: number; minor: number; patch: number; suffix: number }
export type SecurityCheckOptions = {
  host: string
  authEnabled: boolean
  encryptedTransport: boolean
  tmuxVersion: string | null
  passwordChangeRequired?: boolean
}

function parseTmuxVersion(value: string): TmuxVersion | null {
  const match = value.trim().match(/(?:tmux\s+)?(\d+)\.(\d+)(?:\.(\d+))?([a-z])?/i)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0), suffix: match[4] ? match[4].toLowerCase().charCodeAt(0) - 96 : 0 }
}
function compareTmuxVersions(left: TmuxVersion, right: TmuxVersion) {
  for (const key of ['major', 'minor', 'patch', 'suffix'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  return 0
}
export function isLoopbackHost(host: string) {
  const value = host.trim().toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
}
export function isEncryptedTransportConfigured() {
  const publicUrl = process.env.TMUXGO_PUBLIC_URL?.trim() || ''
  if (/^https:\/\//i.test(publicUrl) || /^wss:\/\//i.test(publicUrl)) return true
  return ['TMUXGO_TLS_TERMINATED', 'TMUXGO_ENCRYPTED_TRANSPORT'].some((name) => ['1', 'true', 'yes', 'on'].includes((process.env[name] || '').trim().toLowerCase()))
}
export function isInsecureModeAllowed() {
  return ['1', 'true', 'yes', 'on'].includes((process.env.TMUXGO_ALLOW_INSECURE || '').trim().toLowerCase())
}
export function isTmuxVersionSupported(version: string | null) {
  const parsed = version ? parseTmuxVersion(version) : null
  const minimum = parseTmuxVersion(RECOMMENDED_TMUX_VERSION)!
  return !!parsed && compareTmuxVersions(parsed, minimum) >= 0
}
export function getSecurityWarnings(options: SecurityCheckOptions) {
  const warnings: string[] = []
  const loopback = isLoopbackHost(options.host)
  if (!options.authEnabled) warnings.push('Authentication is disabled; anyone who can reach the Gateway can control terminal sessions.')
  else if (options.passwordChangeRequired) warnings.push('The default admin password is still active; change it before exposing the Gateway beyond localhost.')
  if (!loopback && !options.encryptedTransport) warnings.push(`Gateway is listening on ${options.host} without an encrypted transport; use HTTPS/WSS, a VPN, or an SSH tunnel.`)
  if (!options.tmuxVersion) warnings.push(`Unable to determine the tmux version; install tmux ${RECOMMENDED_TMUX_VERSION} or newer and verify distro security backports.`)
  else if (!isTmuxVersionSupported(options.tmuxVersion)) warnings.push(`tmux ${options.tmuxVersion.trim().replace(/^tmux\s+/i, '')} is below the recommended security baseline ${RECOMMENDED_TMUX_VERSION}; upgrade tmux or install a distro-patched package.`)
  return warnings
}
export async function detectTmuxVersion() {
  try {
    const { stdout } = await execFileAsync('tmux', ['-V'])
    return String(stdout).trim() || null
  } catch {
    return null
  }
}
