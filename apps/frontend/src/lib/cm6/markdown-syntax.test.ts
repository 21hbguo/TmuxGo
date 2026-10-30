import { describe, expect, it } from 'vitest'
import { scanMarkdown, scanMarkdownRanges, type MdRangeKind } from './markdown-syntax'

const ranges = (text: string, kind?: MdRangeKind) => {
  const all = scanMarkdownRanges(text)
  return (kind ? all.filter((range) => range.kind === kind) : all).map((range) => text.slice(range.from, range.to))
}

const allRanges = (text: string) => scanMarkdownRanges(text)

describe('scanMarkdownRanges', () => {
  it('空文档不产出任何区间', () => {
    expect(scanMarkdownRanges('')).toEqual([])
    expect(scanMarkdown('')).toEqual({ ranges: [], blocks: [], styles: [] })
  })

  it('普通段落不产出区间', () => {
    expect(ranges('just text, no markup')).toEqual([])
  })

  it('六级标题：标记含紧随空格，level 对应级别', () => {
    for (let level = 1; level <= 6; level += 1) {
      const text = `${'#'.repeat(level)} 标题${level}`
      const [range] = allRanges(text)
      expect(text.slice(range.from, range.to)).toBe(`${'#'.repeat(level)} `)
      expect(range).toMatchObject({ kind: 'heading-marker', level })
    }
  })

  it('标题收尾的 ### 也一起藏掉', () => {
    expect(ranges('# Title ###', 'heading-marker')).toEqual(['# ', '###'])
  })

  it('#x 不是标题（缺空格），保持源码', () => {
    expect(allRanges('#x')).toEqual([])
  })

  it('标题内联强调同时被扫描', () => {
    expect(ranges('## 中文 **粗**')).toEqual(['## ', '**', '**'])
  })

  it('粗体的标记区间只是 ** 本身，正文进 styles', () => {
    const text = 'a **bold** b'
    expect(ranges(text, 'strong')).toEqual(['**', '**'])
    expect(scanMarkdown(text).styles).toEqual([{ from: 4, to: 8, kind: 'strong' }])
  })

  it('斜体与删除线分别识别', () => {
    const text = '*em* ~~gone~~'
    expect(ranges(text, 'emphasis')).toEqual(['*', '*'])
    expect(ranges(text, 'strikethrough')).toEqual(['~~', '~~'])
    expect(scanMarkdown(text).styles.map((style) => text.slice(style.from, style.to))).toEqual(['em', 'gone'])
  })

  it('行内代码藏反引号，正文单列为等宽样式', () => {
    const text = 'use `pnpm test` now'
    expect(ranges(text, 'inline-code')).toEqual(['`', '`'])
    expect(scanMarkdown(text).styles).toEqual([{ from: 5, to: 14, kind: 'inline-code' }])
  })

  it('多反引号的行内代码按成对标记处理', () => {
    const text = '``a`b``'
    expect(ranges(text, 'inline-code')).toEqual(['``', '``'])
    expect(scanMarkdown(text).styles).toEqual([{ from: 2, to: 5, kind: 'inline-code' }])
  })

  it('三重强调：外层斜体与内层粗体各自出标记', () => {
    const text = '***x***'
    expect(ranges(text, 'emphasis')).toEqual(['*', '*'])
    expect(ranges(text, 'strong')).toEqual(['**', '**'])
    // 外层 Emphasis 内容 1..6（**x**），内层 StrongEmphasis 内容 3..4（x）
    expect(scanMarkdown(text).styles).toEqual([
      { from: 1, to: 6, kind: 'emphasis' },
      { from: 3, to: 4, kind: 'strong' },
    ])
  })

  it('链接：藏 [ 、]( 、url 、)，保留 text 并记录 url', () => {
    const text = 'see [docs](https://a.example/x) now'
    expect(ranges(text, 'link')).toEqual(['[', '](', 'https://a.example/x', ')'])
    const [, , urlRange] = allRanges(text).filter((range) => range.kind === 'link')
    expect(urlRange.url).toBe('https://a.example/x')
    expect(scanMarkdown(text).styles).toEqual([{ from: 5, to: 9, kind: 'link' }])
  })

  it('带 title 的链接把 title 连同前导空格一起藏掉', () => {
    const text = '[a](b "t")'
    expect(ranges(text, 'link')).toEqual(['[', '](', 'b', ' "t"', ')'])
  })

  it('引用式链接没有 URL：整段保留源码', () => {
    expect(allRanges('[ref][r]')).toEqual([])
  })

  it('autolink 只藏尖括号，URL 按链接样式显示', () => {
    const text = '<https://x.example>'
    expect(ranges(text, 'link')).toEqual(['<', '>'])
    expect(scanMarkdown(text).styles).toEqual([{ from: 1, to: 18, kind: 'link' }])
  })

  it('图片整段替换，记录 alt 与 src', () => {
    const text = '![alt text](./img/a.png)'
    const [range] = allRanges(text)
    expect(text.slice(range.from, range.to)).toBe(text)
    expect(range).toMatchObject({ kind: 'image', text: 'alt text', url: './img/a.png' })
  })

  it('链接包图片时两者互不重叠', () => {
    const text = '[![a](b.png)](https://x.example)'
    const all = allRanges(text)
    expect(all.map((range) => text.slice(range.from, range.to))).toEqual([
      '[',
      '![a](b.png)',
      '](',
      'https://x.example',
      ')',
    ])
    for (let i = 1; i < all.length; i += 1) expect(all[i].from).toBeGreaterThanOrEqual(all[i - 1].to)
  })

  it('三种无序列表符号都含紧随空格', () => {
    for (const mark of ['-', '*', '+']) {
      expect(ranges(`${mark} item`, 'bullet')).toEqual([`${mark} `])
    }
  })

  it('有序列表保留编号源码', () => {
    expect(allRanges('1. one\n2. two')).toEqual([])
  })

  it('嵌套列表逐层产出 bullet', () => {
    expect(ranges('- a\n  - b\n    - c', 'bullet')).toEqual(['- ', '- ', '- '])
  })

  it('引用行藏 > 与空格，嵌套引用逐个产出', () => {
    expect(ranges('> quoted', 'quote')).toEqual(['> '])
    expect(ranges('> > nested', 'quote')).toEqual(['> ', '> '])
  })

  it('引用内列表同时产出 quote 与 bullet', () => {
    const text = '> - item'
    expect(ranges(text)).toEqual(['> ', '- '])
  })

  it('任务清单记录勾选状态', () => {
    const done = '- [x] done'
    const open = '- [ ] open'
    const upper = '- [X] upper'
    expect(ranges(done, 'task')).toEqual(['[x]'])
    expect(allRanges(done).find((range) => range.kind === 'task')?.checked).toBe(true)
    expect(allRanges(open).find((range) => range.kind === 'task')?.checked).toBe(false)
    expect(allRanges(upper).find((range) => range.kind === 'task')?.checked).toBe(true)
  })

  it('代码围栏：info 串单列，块区间交给行样式', () => {
    const text = '```ts\nconst a = 1\n```\n'
    const scan = scanMarkdown(text)
    expect(scan.ranges.map((range) => text.slice(range.from, range.to))).toEqual(['ts'])
    expect(scan.ranges[0]).toMatchObject({ kind: 'code-fence-info', text: 'ts' })
    expect(scan.blocks).toEqual([{ kind: 'fenced-code', from: 0, to: 21, lang: 'ts' }])
  })

  it('无语言围栏不产出 info 区间，但仍是围栏块', () => {
    const scan = scanMarkdown('```\nx\n```')
    expect(scan.ranges).toEqual([])
    expect(scan.blocks).toMatchObject([{ kind: 'fenced-code', lang: '' }])
  })

  it('表格本轮不替换，只标记块区间', () => {
    const text = '| a | b |\n| - | - |\n| 1 | 2 |'
    const scan = scanMarkdown(text)
    expect(scan.ranges).toEqual([])
    expect(scan.blocks).toEqual([{ kind: 'table', from: 0, to: text.length }])
  })

  it('setext 标题保留源码', () => {
    expect(allRanges('Title\n=====')).toEqual([])
  })

  it('混合文档：区间升序、非空、不跨行，且能被原样 slice 还原', () => {
    const text = [
      '# Title',
      '',
      '- [x] **bold** and `code`',
      '- plain [l](u) item',
      '',
      '> quote ~~gone~~',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '![pic](p.png)',
    ].join('\n')
    const all = allRanges(text)
    expect(all.length).toBeGreaterThan(10)
    for (const range of all) {
      expect(range.from).toBeLessThan(range.to)
      expect(text.slice(range.from, range.to)).not.toContain('\n')
    }
    for (let i = 1; i < all.length; i += 1) expect(all[i].from).toBeGreaterThanOrEqual(all[i - 1].from)
  })
})
