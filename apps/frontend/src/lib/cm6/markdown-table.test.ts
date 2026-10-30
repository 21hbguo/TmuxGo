import { describe, expect, it } from 'vitest'
import { parseMarkdownTable } from './markdown-table'

describe('parseMarkdownTable', () => {
  it('parses header, alignment and rows', () => {
    const table = parseMarkdownTable('| 名称 | 值 | 说明 |\n|:--|--:|:--:|\n| a | 1 | 中文 |\n| b | 2 | x |')
    expect(table).toEqual({
      header: ['名称', '值', '说明'],
      aligns: ['left', 'right', 'center'],
      rows: [
        ['a', '1', '中文'],
        ['b', '2', 'x'],
      ],
    })
  })
  it('accepts rows without outer pipes', () => {
    const table = parseMarkdownTable('a | b\n--- | ---\n1 | 2')
    expect(table?.header).toEqual(['a', 'b'])
    expect(table?.rows).toEqual([['1', '2']])
  })
  it('keeps escaped pipes and pipes inside code spans', () => {
    const table = parseMarkdownTable('| a | b |\n|---|---|\n| x\\|y | `p|q` |')
    expect(table?.rows[0]).toEqual(['x|y', '`p|q`'])
  })
  it('pads missing cells and drops extra cells', () => {
    const table = parseMarkdownTable('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')
    expect(table?.rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ])
  })
  it('rejects a separator with the wrong width or malformed dashes', () => {
    expect(parseMarkdownTable('| a | b |\n|---|\n| 1 | 2 |')).toBeNull()
    expect(parseMarkdownTable('| a |\n| x |\n| 1 |')).toBeNull()
    expect(parseMarkdownTable('only one line')).toBeNull()
  })
})
