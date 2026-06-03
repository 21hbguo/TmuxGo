import { describe, expect, it } from 'vitest'
import { analyzePaste, escapePaste } from './paste-safety'

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
    expect(analyzePaste('line1\nline2')).toMatchObject({ requiresConfirm: true, hasNewline: true, hasControlChars: false, isLong: false })
    expect(analyzePaste('abc\u0007')).toMatchObject({ requiresConfirm: true, hasNewline: false, hasControlChars: true, isLong: false })
    expect(analyzePaste('x'.repeat(121))).toMatchObject({ requiresConfirm: true, hasNewline: false, hasControlChars: false, isLong: true })
  })
  it('escapes newlines and tabs for confirmation preview', () => {
    expect(escapePaste('a\r\nb\tc\nd')).toBe('a\\nb\\tc\\nd')
  })
})
