import type { StreamSession } from './stream-session.js'

// Browser oversized paste: paste-data <hostId> <sessionName>\n<utf8 payload>
// Mirrors frontend encodePasteBinary / agent vnc-data prefix convention.
export const PASTE_BINARY_MAX_BYTES = 1024 * 1024

export function parsePasteDataFrame(frame: Buffer): { hostId: string; sessionName: string; data: string } | null {
  const separator = frame.indexOf(0x0a)
  if (separator < 0) return null
  const header = frame.toString('ascii', 0, separator)
  if (!header.startsWith('paste-data ')) return null
  const rest = header.slice('paste-data '.length)
  const sp = rest.indexOf(' ')
  if (sp <= 0 || sp === rest.length - 1) return null
  const hostId = rest.slice(0, sp)
  const sessionName = rest.slice(sp + 1)
  if (!hostId || !sessionName) return null
  const payload = frame.subarray(separator + 1)
  if (payload.length > PASTE_BINARY_MAX_BYTES) return null
  return { hostId, sessionName, data: payload.toString('utf8') }
}

// Validates attach target then writes via session.input (passive-safe).
export function applyPasteDataFrame(
  session: StreamSession,
  frame: Buffer,
): 'ok' | 'mismatch' | 'too_large' | 'invalid' {
  const separator = frame.indexOf(0x0a)
  if (separator < 0) return 'invalid'
  const header = frame.toString('ascii', 0, separator)
  if (!header.startsWith('paste-data ')) return 'invalid'
  const payload = frame.subarray(separator + 1)
  if (payload.length > PASTE_BINARY_MAX_BYTES) return 'too_large'
  const rest = header.slice('paste-data '.length)
  const sp = rest.indexOf(' ')
  if (sp <= 0 || sp === rest.length - 1) return 'invalid'
  const hostId = rest.slice(0, sp)
  const sessionName = rest.slice(sp + 1)
  if (!hostId || !sessionName || hostId !== session.attachedHostId || sessionName !== session.attachedSessionName)
    return 'mismatch'
  session.input(payload.toString('utf8'))
  return 'ok'
}
