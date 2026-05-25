export interface PasteAnalysis {
  requiresConfirm: boolean
  hasNewline: boolean
  hasControlChars: boolean
  isLong: boolean
}

const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/
const LONG_PASTE_THRESHOLD = 120

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
