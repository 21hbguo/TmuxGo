import { isValidSessionName } from './tmux-policy.js'

export interface ParsedSessionRef {
  hostId: string
  sessionName: string
  sessionId: string
}
function isValidHostId(value: string) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value)
}
function normalizeHostId(value: string) {
  const hostId = value.trim()
  if (!isValidHostId(hostId)) throw new Error('Invalid host id')
  return hostId
}
export function buildSessionId(hostId: string, sessionName: string) {
  const normalizedHostId = normalizeHostId(hostId)
  if (!isValidSessionName(sessionName)) throw new Error('Invalid session name')
  return `session-${normalizedHostId}-${sessionName}`
}
export function parseSessionRef(hostIdRaw: string, sessionRef: string): ParsedSessionRef {
  const hostId = normalizeHostId(hostIdRaw)
  const value = sessionRef.trim()
  if (!value) throw new Error('Invalid session id')
  if (value.startsWith('session-')) {
    const expectedPrefix = `session-${hostId}-`
    if (value.startsWith(expectedPrefix)) {
      const sessionName = value.slice(expectedPrefix.length)
      if (!isValidSessionName(sessionName)) throw new Error('Invalid session name')
      return { hostId, sessionName, sessionId: buildSessionId(hostId, sessionName) }
    }
    if (hostId === 'local') {
      const legacySessionName = value.slice('session-'.length)
      if (!isValidSessionName(legacySessionName)) throw new Error('Invalid session name')
      return { hostId, sessionName: legacySessionName, sessionId: buildSessionId(hostId, legacySessionName) }
    }
    throw new Error('Session does not belong to host')
  }
  if (!isValidSessionName(value)) throw new Error('Invalid session name')
  return { hostId, sessionName: value, sessionId: buildSessionId(hostId, value) }
}
