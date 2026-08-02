import type { HostCredentials, HostRecord } from './hosts.js'

export function resolveHostPassword(credentials: HostCredentials) {
  if (credentials.password) return credentials.password
  if (!credentials.passwordEnv) return ''
  return process.env[credentials.passwordEnv] || ''
}
export function buildHostSshOptions(host: HostRecord, credentials: HostCredentials) {
  const args: string[] = []
  if (credentials.privateKeyPath) args.push('-i', credentials.privateKeyPath)
  if (!host.useAgent) args.push('-o', 'IdentityAgent=none')
  if (host.jumpHost) args.push('-J', host.jumpHost)
  args.push('-o', `StrictHostKeyChecking=${host.knownHostsPolicy === 'strict' ? 'yes' : host.knownHostsPolicy === 'off' ? 'no' : 'accept-new'}`)
  return args
}
