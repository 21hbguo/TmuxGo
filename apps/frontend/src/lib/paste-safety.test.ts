import { describe, expect, it } from 'vitest'
import {
  analyzePaste,
  encodePasteBinary,
  escapePaste,
  parsePasteBinary,
  PASTE_BINARY_THRESHOLD,
  shouldUsePasteBinary,
} from './paste-safety'

const BEL = String.fromCharCode(7)

describe('paste-safety', () => {
  it('does not require confirmation for short plain text', () => {
    expect(analyzePaste('echo hello')).toEqual({
      requiresConfirm: false,
      hasNewline: false,
      hasControlChars: false,
      isLong: false,
    })
  })
  it('requires confirmation for multiline, control-char, and long pastes', () => {
    expect(analyzePaste('line1\nline2')).toMatchObject({
      requiresConfirm: true,
      hasNewline: true,
      hasControlChars: false,
      isLong: false,
    })
    expect(analyzePaste('abc' + BEL)).toMatchObject({
      requiresConfirm: true,
      hasNewline: false,
      hasControlChars: true,
      isLong: false,
    })
    expect(analyzePaste('x'.repeat(121))).toMatchObject({
      requiresConfirm: true,
      hasNewline: false,
      hasControlChars: false,
      isLong: true,
    })
  })
  it('escapes newlines and tabs for confirmation preview', () => {
    expect(escapePaste('a\r\nb\tc\nd')).toBe('a\\nb\\tc\\nd')
  })
})

describe('paste binary threshold and frame', () => {
  it('keeps small input on the JSON path', () => {
    expect(shouldUsePasteBinary('x'.repeat(PASTE_BINARY_THRESHOLD))).toBe(false)
    expect(shouldUsePasteBinary('x'.repeat(10))).toBe(false)
  })

  it('routes oversized paste through the binary path', () => {
    expect(shouldUsePasteBinary('x'.repeat(PASTE_BINARY_THRESHOLD + 1))).toBe(true)
  })

  it('encodes and decodes a paste-data frame round-trip', () => {
    const text = 'echo hello\nsecond line\ttab 中文'
    const frame = encodePasteBinary('local', 'dev session', text)
    const headerEnd = frame.indexOf(0x0a)
    expect(headerEnd).toBeGreaterThan(0)
    const header = new TextDecoder().decode(frame.subarray(0, headerEnd))
    expect(header).toBe('paste-data local dev session')
    const decoded = parsePasteBinary(frame)
    expect(decoded).toEqual({ hostId: 'local', sessionName: 'dev session', data: text })
  })

  it('rejects frames without a paste-data header or incomplete identity', () => {
    expect(parsePasteBinary(new TextEncoder().encode('vnc-data x\nyy'))).toBeNull()
    expect(parsePasteBinary(new TextEncoder().encode('paste-data onlyhost\nyy'))).toBeNull()
    expect(parsePasteBinary(new TextEncoder().encode('paste-data h s'))).toBeNull()
    expect(parsePasteBinary(new Uint8Array(0))).toBeNull()
  })
})
