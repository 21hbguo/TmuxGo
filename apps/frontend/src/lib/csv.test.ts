import { describe, expect, it } from 'vitest'
import {
  detectDelimiter,
  filterTableRows,
  parseCsv,
  parseCsvTable,
  serializeDelimited,
  serializeTsv,
  sliceTable,
  sortTableRows,
  toMarkdownTable,
} from './csv'

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

describe('csv table parsing', () => {
  it('strips the UTF-8 BOM from the first header cell', () => {
    const result = parseCsvTable('\ufeffa,b\n1,2')
    expect(result.hadBom).toBe(true)
    expect(result.rows[0]).toEqual(['a', 'b'])
    expect(result.rows[0][0].charCodeAt(0)).toBe('a'.charCodeAt(0))
  })
  it('auto-detects semicolon, tab and pipe delimiters', () => {
    expect(parseCsvTable('a;b\n1;2').delimiter).toBe(';')
    expect(parseCsvTable('a\tb\n1\t2').delimiter).toBe('\t')
    expect(parseCsvTable('a|b\n1|2').delimiter).toBe('|')
    expect(parseCsvTable('a,b\n1,2').delimiter).toBe(',')
  })
  it('ignores delimiters inside quoted fields when detecting', () => {
    const result = parseCsvTable('"a;b;c",d\n"x;y",z')
    expect(result.delimiter).toBe(',')
    // 引号里的分号不参与计数，但分号列数仍为 2
    expect(result.rows[0]).toEqual(['a;b;c', 'd'])
  })
  it('keeps user blank rows but drops only the trailing newline row', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2'], ['']])
  })
  it('honours an explicit delimiter over detection', () => {
    expect(parseCsv('a;b\n1;2', { delimiter: ',' })).toEqual([['a;b'], ['1;2']])
  })
})

describe('csv serialization', () => {
  it('quotes fields containing delimiter, quotes and newlines', () => {
    const rows = [
      ['a,b', 'plain', 'he said "hi"'],
      ['line\nbreak', 'tab\tvalue', ''],
    ]
    const text = serializeDelimited(rows)
    expect(text).toBe('"a,b",plain,"he said ""hi"""\n"line\nbreak",tab\tvalue,')
    expect(parseCsv(text)).toEqual(rows)
  })
  it('serializes TSV with tabs and keeps commas untouched', () => {
    expect(
      serializeTsv([
        ['a,b', 'c'],
        ['1', '2'],
      ]),
    ).toBe('a,b\tc\n1\t2')
  })
  it('builds a markdown table with escaped pipes and newlines', () => {
    const table = toMarkdownTable([
      ['name', 'note'],
      ['a|b', 'x\ny'],
    ])
    expect(table).toBe('| name | note |\n| --- | --- |\n| a\\|b | x<br>y |')
    expect(toMarkdownTable([])).toBe('')
  })
})

describe('csv table slice and transforms', () => {
  it('caps rows/columns without spreading huge arrays', () => {
    const rows = Array.from({ length: 130_000 }, (_, index) => [`r${index}`, 'x', 'y'])
    const slice = sliceTable(rows, 5000, 2)
    expect(slice.rows).toHaveLength(5000)
    expect(slice.rows[0]).toHaveLength(2)
    expect(slice.totalRows).toBe(130_000)
    expect(slice.totalCols).toBe(3)
    expect(slice.truncatedRows).toBe(125_000)
    expect(slice.truncatedCols).toBe(1)
  })
  it('sorts numbers numerically and keeps the header row', () => {
    const rows = [
      ['n', 'label'],
      ['10', 'b'],
      ['9', 'a'],
      ['2', 'c'],
    ]
    expect(sortTableRows(rows, 0, 'asc', true)).toEqual([
      ['n', 'label'],
      ['2', 'c'],
      ['9', 'a'],
      ['10', 'b'],
    ])
    expect(sortTableRows(rows, 1, 'desc', true)[1]).toEqual(['2', 'c'])
  })
  it('filters body rows case-insensitively and keeps the header', () => {
    const rows = [
      ['name', 'city'],
      ['Alice', 'Beijing'],
      ['bob', 'Shanghai'],
    ]
    expect(filterTableRows(rows, 'bei', true)).toEqual([
      ['name', 'city'],
      ['Alice', 'Beijing'],
    ])
    expect(filterTableRows(rows, '', true)).toBe(rows)
  })
  it('detectDelimiter falls back to comma for single-column data', () => {
    expect(detectDelimiter('a\nb\nc')).toBe(',')
  })
})
