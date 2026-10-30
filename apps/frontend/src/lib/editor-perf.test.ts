import { describe, expect, it } from 'vitest'
import { computeSelectionStats, convertEol, detectEol, detectIndent } from './editor-status'
import { extractOutline } from './editor-outline'
import { filterQuickPick, parseGotoLine } from './editor-quickpick'
import { idsToCloseOthers, idsToCloseSaved, idsToCloseToRight } from './editor-tab-actions'
import { renderMarkdown } from './markdown'
import { parseCsvTable, sliceTable, sortTableRows } from './csv'

// 编辑区延迟预算（CI 守卫）：这里只断言「不退化到肉眼可感」，阈值给足冗余——
// 实测远低于预算（见 scripts/measure-editor-latency.ts），拦的是 O(n²)/重复解析这类回归。
// 判定口径：单次调用耗时（markdown 为一次整篇渲染）。
const MEDIUM = 60

const time = (run: () => void) => {
  run()
  const started = performance.now()
  run()
  return performance.now() - started
}

const tsFile = (lines: number) =>
  Array.from({ length: lines }, (_, index) =>
    index % 40 === 0 ? `export function handler${index}(input: string) {` : `  const value${index} = input.length`,
  ).join('\n')

describe('editor latency budgets', () => {
  it('extracts a 20k line outline well under a frame budget', () => {
    const source = tsFile(20_000)
    expect(time(() => void extractOutline('typescript', source))).toBeLessThan(150)
  })

  it('filters a 2k item quick pick within a keystroke', () => {
    const items = Array.from({ length: 2_000 }, (_, index) => ({
      id: `item-${index}`,
      label: `Editor Command ${index} — Toggle Something Useful`,
      keywords: [`cmd${index}`],
    }))
    const elapsed = time(() => {
      for (const query of ['e', 'ed', 'edit', 'editor', 'editor c', 'toggle']) filterQuickPick(items, query)
    })
    // 6 次连续输入（每次都是一帧内的活）合计 < 60ms
    expect(elapsed).toBeLessThan(MEDIUM)
  })

  // jsdom 的 DOMPurify 比真实浏览器慢一个量级（实测同一份 200KB：jsdom 0.8s / Chrome 数十毫秒），
  // 所以这里只拦「行号统计退化成 O(n²)」这类回归——修复前同一用例 3.8s，修复后 0.8s。
  it('renders a 200KB markdown document without quadratic line mapping', () => {
    const block = '## 标题\n\n正文段落，含 `code`、**粗体** 与 [链接](https://example.com)。\n\n- 一\n- 二\n\n'
    const doc = block.repeat(Math.ceil((200 * 1024) / block.length))
    expect(doc.length).toBeGreaterThan(200 * 1024)
    expect(time(() => void renderMarkdown(doc))).toBeLessThan(2000)
  })

  it('detects indent and line endings on 40k line documents cheaply', () => {
    const indented = '  const value = 1\n'.repeat(40_000)
    const crlf = 'const value = 1\r\n'.repeat(40_000)
    expect(time(() => void detectIndent(indented))).toBeLessThan(MEDIUM)
    expect(time(() => void detectEol(crlf))).toBeLessThan(MEDIUM)
    expect(time(() => void convertEol(crlf, '\n'))).toBeLessThan(MEDIUM)
  })

  it('keeps selection stats and tab batch math sub-millisecond', () => {
    const elapsed = time(() => {
      for (let index = 0; index < 50; index += 1)
        computeSelectionStats({ startLineNumber: 1, startColumn: 1, endLineNumber: 10_000, endColumn: 40 }, () => 40)
      const ids = Array.from({ length: 500 }, (_, item) => `editor-${item}`)
      idsToCloseOthers(ids, 'editor-0')
      idsToCloseToRight(ids, 'editor-250')
      idsToCloseSaved(ids, (id) => Number(id.split('-')[1]) % 3 === 0)
      for (let index = 0; index < 500; index += 1) parseGotoLine(`${index}:3`, 20_000)
    })
    expect(elapsed).toBeLessThan(MEDIUM)
  })

  // CSV 是本次补强的重点：十万行级不能靠 Math.max(...spread)，切片与排序都必须有界
  it('slices a 200k row csv table without spreading the array', () => {
    const rows = Array.from({ length: 200_000 }, (_, index) => [`row-${index}`, String(index), 'x'])
    expect(time(() => void sliceTable(rows, 5000, 128))).toBeLessThan(100)
  })

  it('parses and sorts a 0.7MB csv file within a preview tick', () => {
    const body = Array.from({ length: 40_000 }, (_, index) => `${index},name-${index},${index % 97}`).join('\n')
    const content = `id,name,score\n${body}`
    expect(content.length).toBeGreaterThan(512 * 1024)
    const parsed = parseCsvTable(content)
    expect(time(() => void sortTableRows(parsed.rows, 2, 'desc', true))).toBeLessThan(1500)
  })
})
