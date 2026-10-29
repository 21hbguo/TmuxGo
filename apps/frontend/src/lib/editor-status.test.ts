import { describe, expect, it } from 'vitest'
import {
  computeSelectionStats,
  convertEol,
  detectEol,
  detectIndent,
  eolLabel,
  languageLabel,
} from './editor-status'

describe('detectEol', () => {
  it('detects LF when no carriage returns exist', () => {
    expect(detectEol('a\nb\nc')).toEqual({ eol: '\n', mixed: false })
  })

  it('detects CRLF when most line breaks are CRLF', () => {
    expect(detectEol('a\r\nb\r\nc')).toEqual({ eol: '\r\n', mixed: false })
  })

  it('flags mixed endings and prefers the majority', () => {
    expect(detectEol('a\r\nb\r\nc\nd')).toEqual({ eol: '\r\n', mixed: true })
    expect(detectEol('a\nb\nc\r\nd')).toEqual({ eol: '\n', mixed: true })
  })

  it('treats an empty file as LF', () => {
    expect(detectEol('')).toEqual({ eol: '\n', mixed: false })
  })

  it('only samples the head of very large files', () => {
    // 头 3MB 全是 CRLF（超过 2MB 采样窗），尾部再堆 1.2MB 的 LF：
    // 只看头部就应判定 CRLF；若实现扫描全文，mixed 会变 true
    const content = `${'a\r\n'.repeat(1_000_000)}${'b\n'.repeat(1_200_000)}`
    expect(detectEol(content)).toEqual({ eol: '\r\n', mixed: false })
  })
})

describe('convertEol', () => {
  it('normalises mixed endings in both directions', () => {
    expect(convertEol('a\r\nb\nc\rd', '\n')).toBe('a\nb\nc\nd')
    expect(convertEol('a\r\nb\nc\rd', '\r\n')).toBe('a\r\nb\r\nc\r\nd')
  })

  it('is idempotent for the target ending', () => {
    expect(convertEol('a\r\nb', '\r\n')).toBe('a\r\nb')
    expect(convertEol('a\nb', '\n')).toBe('a\nb')
  })
})

describe('detectIndent', () => {
  it('reads two-space indentation', () => {
    expect(detectIndent('function a() {\n  if (x) {\n    return 1\n  }\n}')).toEqual({
      tabSize: 2,
      insertSpaces: true,
    })
  })

  it('reads four-space indentation', () => {
    expect(detectIndent('def a():\n    if x:\n        return 1')).toEqual({ tabSize: 4, insertSpaces: true })
  })

  it('prefers tabs when tab indented lines dominate', () => {
    expect(detectIndent('a\n\tb\n\t\tc\n\td').insertSpaces).toBe(false)
  })

  it('falls back for files without indentation', () => {
    expect(detectIndent('a\nb\nc', { tabSize: 4, insertSpaces: true })).toEqual({ tabSize: 4, insertSpaces: true })
  })

  it('ignores odd indentation widths that are not valid tab sizes', () => {
    expect(detectIndent('a\n   b').tabSize).toBe(2)
  })
})

describe('computeSelectionStats', () => {
  const lengths = (line: number) => [0, 10, 5, 0][line] ?? 0

  it('returns null for an empty selection', () => {
    expect(
      computeSelectionStats({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 }, lengths),
    ).toBeNull()
  })

  it('counts a single-line selection by column delta', () => {
    expect(
      computeSelectionStats({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 6 }, lengths),
    ).toEqual({ lines: 1, chars: 4 })
  })

  it('sums characters across lines including line breaks', () => {
    expect(
      computeSelectionStats({ startLineNumber: 1, startColumn: 5, endLineNumber: 2, endColumn: 3 }, lengths),
    ).toEqual({ lines: 2, chars: 6 + 1 + 2 })
  })

  it('clamps to line length when the end column overshoots', () => {
    expect(
      computeSelectionStats({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 99 }, lengths),
    ).toEqual({ lines: 2, chars: 10 + 1 + 5 })
  })
})

describe('labels', () => {
  it('maps language ids to display names and falls back to the id', () => {
    expect(languageLabel('typescript')).toBe('TypeScript')
    expect(languageLabel('cpp')).toBe('C++')
    expect(languageLabel('wat')).toBe('wat')
  })

  it('labels line endings the way the status bar shows them', () => {
    expect(eolLabel('\n')).toBe('LF')
    expect(eolLabel('\r\n')).toBe('CRLF')
  })
})
