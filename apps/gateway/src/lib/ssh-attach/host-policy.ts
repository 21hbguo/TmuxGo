const allowedHosts = new Set((process.env.TMUXGO_SSH_ALLOWED_HOSTS || '').split(',').map((hostId) => hostId.trim()).filter(Boolean))
export function isSshHostAllowed(sshUser: string, hostId: string): boolean {
  if (!allowedHosts.size) return true
  return allowedHosts.has(hostId) || allowedHosts.has(`${sshUser}@${hostId}`)
}
export function assertSshHostAllowed(sshUser: string, hostId: string): void {
  if (!isSshHostAllowed(sshUser, hostId)) throw new Error('Host is not allowed for SSH user')
}
