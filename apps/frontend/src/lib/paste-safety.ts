export interface PasteAnalysis {
  requiresConfirm: boolean
  hasNewline: boolean
  hasControlChars: boolean
  isLong: boolean
}

const CONTROL_CHAR_PATTERN = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f]')
const LONG_PASTE_THRESHOLD = 120
export const PASTE_BINARY_THRESHOLD = (() => {
  const raw =
    typeof process !== 'undefined' && process.env && process.env.TMUXGO_PASTE_BINARY_THRESHOLD
      ? Number(process.env.TMUXGO_PASTE_BINARY_THRESHOLD)
      : NaN
  return Number.isFinite(raw) && raw >= 1024 ? raw : 16 * 1024
})()

export function analyzePaste(text: string): PasteAnalysis {
  const hasNewline = /\r|\n/.test(text)
  const hasControlChars = CONTROL_CHAR_PATTERN.test(text)
  const isLong = text.length > LONG_PASTE_THRESHOLD
  return {
    requiresConfirm: hasNewline || hasControlChars || isLong,
    hasNewline,
    hasControlChars,
    isLong,
  }
}

export function escapePaste(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

export function shouldUsePasteBinary(data: string): boolean {
  return data.length > PASTE_BINARY_THRESHOLD
}

export function encodePasteBinary(hostId: string, sessionName: string, data: string): Uint8Array {
  const header = `paste-data ${hostId} ${sessionName}\n`
  const headerBytes = new TextEncoder().encode(header)
  const payload = new TextEncoder().encode(data)
  const frame = new Uint8Array(headerBytes.length + payload.length)
  frame.set(headerBytes, 0)
  frame.set(payload, headerBytes.length)
  return frame
}

export function parsePasteBinary(frame: Uint8Array): { hostId: string; sessionName: string; data: string } | null {
  let newline = -1
  const limit = Math.min(frame.length, 512)
  for (let i = 0; i < limit; i++) {
    if (frame[i] === 0x0a) {
      newline = i
      break
    }
  }
  if (newline < 0) return null
  const header = new TextDecoder().decode(frame.subarray(0, newline))
  if (!header.startsWith('paste-data ')) return null
  const rest = header.slice('paste-data '.length)
  const space = rest.indexOf(' ')
  if (space <= 0 || space === rest.length - 1) return null
  const hostId = rest.slice(0, space)
  const sessionName = rest.slice(space + 1)
  if (!hostId || !sessionName) return null
  const data = new TextDecoder().decode(frame.subarray(newline + 1))
  return { hostId, sessionName, data }
}
