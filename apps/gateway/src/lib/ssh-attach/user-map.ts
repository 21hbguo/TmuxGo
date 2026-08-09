const sshUserMap = new Map<string, string>()
for (const entry of (process.env.TMUXGO_SSH_USER_MAP || '').split(',').map((item) => item.trim()).filter(Boolean)) {
  const separator = entry.indexOf('=')
  if (separator > 0) sshUserMap.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim())
}
export function resolveSshUser(sshUser: string): string {
  return sshUserMap.get(sshUser) ?? sshUser
}
