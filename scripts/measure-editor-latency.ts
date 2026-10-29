import { performance } from 'node:perf_hooks'
import { convertEol, detectEol, detectIndent, computeSelectionStats } from '../apps/frontend/src/lib/editor-status'
import { extractOutline } from '../apps/frontend/src/lib/editor-outline'
import { filterQuickPick, parseGotoLine } from '../apps/frontend/src/lib/editor-quickpick'
import { idsToCloseOthers, idsToCloseSaved, idsToCloseToRight } from '../apps/frontend/src/lib/editor-tab-actions'

// 编辑区热点纯函数延迟基线（不依赖浏览器；markdown 渲染需要 DOM，放在 vitest 预算测试里测）：
// 这些是每个按键/每次打开文件都会跑的 CPU 路径，退化会直接表现为输入卡顿。
// 用法：npx tsx scripts/measure-editor-latency.ts [--json]
// 预算与 apps/frontend/src/lib/editor-perf.test.ts 里的断言同源，CI 用测试拦回归，
// 这里给人看分布（p50/p95/max）与绝对值。
interface Sample {
  name: string
  iterations: number
  p50: number
  p95: number
  max: number
  budgetMs: number
  detail?: string
}

const tsFile = (lines: number) =>
  Array.from({ length: lines }, (_, index) =>
    index % 40 === 0
      ? `export function handler${index}(input: string) {`
      : index % 40 === 39
        ? '}'
        : `  const value${index} = input.length + ${index}`,
  ).join('\n')

const markdownDoc = (kb: number) => {
  const block = [
    '## 小节标题',
    '',
    '一段中文正文，包含 `inline code`、**粗体**、[链接](https://example.com) 与列表：',
    '',
    '- 条目一',
    '- 条目二',
    '',
    '```ts',
    'const value = 1',
    '```',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
  ].join('\n')
  const target = kb * 1024
  let text = ''
  while (text.length < target) text += block
  return text
}

const quickPickItems = Array.from({ length: 2_000 }, (_, index) => ({
  id: `item-${index}`,
  label: `Editor Command ${index} — Toggle Something Useful`,
  keywords: [`cmd${index}`, '编辑器', 'editor'],
}))

function percentile(sorted: number[], ratio: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function measure(name: string, iterations: number, budgetMs: number, run: () => void, detail?: string): Sample {
  // 预热一轮：JIT 与首次分配不该计入分布
  run()
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  return {
    name,
    iterations,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples[samples.length - 1],
    budgetMs,
    detail,
  }
}

const largeSource = tsFile(20_000)
const indentSource = `${'  const value = 1\n'.repeat(40_000)}`
const crlfSource = `${'const value = 1\r\n'.repeat(40_000)}`

const samples: Sample[] = [
  measure('outline: 20k 行 TypeScript', 12, 80, () => void extractOutline('typescript', largeSource), 'textDocument symbols'),
  measure('outline: 20k 行 Markdown', 12, 80, () => void extractOutline('markdown', markdownDoc(400))),
  measure(
    'quickpick: 2k 项过滤（40 次连续输入）',
    8,
    60,
    () => {
      for (const query of ['e', 'ed', 'edi', 'edit', 'edito', 'editor', 'editor ', 'editor c']) filterQuickPick(quickPickItems, query)
    },
    '80 次 filterQuickPick',
  ),
  measure('indent: 40k 行探测', 20, 30, () => void detectIndent(indentSource)),
  measure('eol: 40k 行 CRLF 探测', 20, 30, () => void detectEol(crlfSource)),
  measure('eol: 全文 CRLF→LF 转换（约 600KB）', 10, 60, () => void convertEol(crlfSource, '\n')),
  measure('selection: 10k 行选区统计', 200, 5, () =>
    void computeSelectionStats(
      { startLineNumber: 1, startColumn: 1, endLineNumber: 10_000, endColumn: 40 },
      () => 40,
    ),
  ),
  measure('tab: 500 个 tab 批量关闭三连', 200, 5, () => {
    const ids = Array.from({ length: 500 }, (_, index) => `editor-${index}`)
    idsToCloseOthers(ids, 'editor-0')
    idsToCloseToRight(ids, 'editor-250')
    idsToCloseSaved(ids, (id) => Number(id.split('-')[1]) % 3 === 0)
  }),
  measure('goto: 行号解析 ×1000', 50, 5, () => {
    for (let index = 0; index < 1000; index += 1) parseGotoLine(`${index}:3`, 20_000)
  }),
]

const asJson = process.argv.includes('--json')
if (asJson) {
  console.log(JSON.stringify(samples, null, 2))
} else {
  const pad = (value: string, width: number) => value.padEnd(width)
  console.log(`${pad('场景', 34)}${pad('p50', 10)}${pad('p95', 10)}${pad('max', 10)}${pad('预算', 8)}结论`)
  let failed = 0
  for (const sample of samples) {
    const ok = sample.p95 <= sample.budgetMs
    if (!ok) failed += 1
    console.log(
      `${pad(sample.name, 34)}${pad(`${sample.p50.toFixed(2)}ms`, 10)}${pad(`${sample.p95.toFixed(2)}ms`, 10)}${pad(
        `${sample.max.toFixed(2)}ms`,
        10,
      )}${pad(`${sample.budgetMs}ms`, 8)}${ok ? 'OK' : 'OVER BUDGET'}`,
    )
  }
  console.log(`\n${samples.length - failed}/${samples.length} 场景在预算内（判定口径：p95）`)
  if (failed) process.exitCode = 1
}
