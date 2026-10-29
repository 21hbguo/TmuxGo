import { describe, expect, it } from 'vitest'
import { filterQuickPick, nextIndex, parseGotoLine, scoreQuery } from './editor-quickpick'

describe('scoreQuery', () => {
  it('ranks exact matches above prefix matches', () => {
    expect(scoreQuery('wrap', 'Wrap')).toBeGreaterThan(scoreQuery('wrap', 'Word Wrap'))
    expect(scoreQuery('wrap', 'Word Wrap')).toBeGreaterThan(scoreQuery('wrap', 'Toggle word wrap now'))
  })

  it('matches word prefixes and ranks real prefixes above in-word hits', () => {
    expect(scoreQuery('sym', 'Go to Symbol')).toBeGreaterThan(0)
    expect(scoreQuery('symbol', 'Go to Symbol')).toBeGreaterThan(scoreQuery('symbol', 'ASymbolHere'))
    expect(scoreQuery('symbol', 'Symbol Outline')).toBeGreaterThan(scoreQuery('symbol', 'Go to Symbol'))
  })

  it('matches fuzzy subsequences', () => {
    expect(scoreQuery('gtl', 'Go To Line')).toBeGreaterThan(0)
    expect(scoreQuery('xyz', 'Go To Line')).toBe(0)
  })

  it('falls back to keywords', () => {
    expect(scoreQuery('面包屑', 'Toggle Breadcrumbs', ['面包屑'])).toBeGreaterThan(0)
    expect(scoreQuery('nope', 'Toggle Breadcrumbs', ['面包屑'])).toBe(0)
  })

  it('treats an empty query as match-all', () => {
    expect(scoreQuery('', 'anything')).toBe(1)
    expect(scoreQuery('   ', 'anything')).toBe(1)
  })
})

describe('filterQuickPick', () => {
  const items = [
    { id: 'a', label: 'Go to Line' },
    { id: 'b', label: 'Go to Symbol' },
    { id: 'c', label: 'Toggle Word Wrap', keywords: ['wrap'] },
    { id: 'd', label: 'Save All' },
  ]

  it('filters and keeps the best match first', () => {
    const result = filterQuickPick(items, 'go to symbol')
    expect(result.map((item) => item.id)).toEqual(['b'])
  })

  it('keeps original order for equal scores', () => {
    expect(filterQuickPick(items, '').map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('honours the result limit', () => {
    expect(filterQuickPick(items, '', 2)).toHaveLength(2)
  })
})

describe('parseGotoLine', () => {
  it('parses a bare line number', () => {
    expect(parseGotoLine('42', 100)).toEqual({ line: 42, column: 1 })
  })

  it('parses the leading colon VSCode also accepts', () => {
    expect(parseGotoLine(':7', 100)).toEqual({ line: 7, column: 1 })
  })

  it('parses line:column', () => {
    expect(parseGotoLine('12:5', 100)).toEqual({ line: 12, column: 5 })
  })

  it('clamps to the document and rejects garbage', () => {
    expect(parseGotoLine('999', 100)).toEqual({ line: 100, column: 1 })
    expect(parseGotoLine('0', 100)).toBeNull()
    expect(parseGotoLine('abc', 100)).toBeNull()
    expect(parseGotoLine('', 100)).toBeNull()
    expect(parseGotoLine('12:0', 100)).toBeNull()
  })

  it('treats a zero line count as a single line document', () => {
    expect(parseGotoLine('5', 0)).toEqual({ line: 1, column: 1 })
  })
})

describe('nextIndex', () => {
  it('wraps in both directions', () => {
    expect(nextIndex(0, 3, -1)).toBe(2)
    expect(nextIndex(2, 3, 1)).toBe(0)
    expect(nextIndex(1, 3, 1)).toBe(2)
  })

  it('returns 0 for empty lists', () => {
    expect(nextIndex(5, 0, 1)).toBe(0)
  })
})
