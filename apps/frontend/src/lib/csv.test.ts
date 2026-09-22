import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv'

describe('parseCsv', () => {
  it('parses plain rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })
  it('handles quoted fields with commas, quotes and newlines', () => {
    expect(parseCsv('"x,y","he said ""hi""","a\nb"')).toEqual([['x,y', 'he said "hi"', 'a\nb']])
  })
  it('handles CRLF and drops the trailing empty row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
  it('keeps empty cells between commas', () => {
    expect(parseCsv('a,,c\n,2,')).toEqual([
      ['a', '', 'c'],
      ['', '2', ''],
    ])
  })
  it('returns no rows for empty or blank content', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n')).toEqual([])
  })
})
