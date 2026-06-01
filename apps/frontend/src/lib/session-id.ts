export function buildSessionId(hostId: string, sessionName: string) {
  return `session-${hostId}-${sessionName}`
}
export function parseSessionName(hostId: string, sessionId: string) {
  const nextHostId = (hostId || '').trim()
  const value = (sessionId || '').trim()
  if (!nextHostId || !value) return ''
  const prefix = `session-${nextHostId}-`
  if (value.startsWith(prefix)) return value.slice(prefix.length)
  if (nextHostId === 'local' && value.startsWith('session-')) return value.slice('session-'.length)
  return value
}
