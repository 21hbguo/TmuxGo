import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createMarkdownDecorations } from './decorations'
import { scanMarkdown } from './markdown-syntax'

// live preview 的按键路径：文档变化 → 扫描语法树 → 重建装饰集。
// 这里只测纯扫描（jsdom 下 parse 占大头），拦的是「整篇重复 parse / O(n²)」这类回归。
const time = (run: () => void) => {
  run()
  const started = performance.now()
  run()
  return performance.now() - started
}

const doc = (blocks: number) =>
  Array.from(
    { length: blocks },
    (_, index) =>
      `## 标题 ${index}\n\n正文 **粗体** 与 *斜体*、\`inline\`、[链接](https://example.com/${index})。\n\n- 项目 A\n- [x] 完成项\n\n> 引用行\n\n\`\`\`ts\nconst value = ${index}\n\`\`\`\n`,
  ).join('\n')

describe('cm6 markdown scan budgets', () => {
  it('scans a 3000 block (~375KB) document within a keystroke budget', () => {
    const text = doc(3000)
    expect(text.length).toBeGreaterThan(300 * 1024)
    expect(time(() => void scanMarkdown(text))).toBeLessThan(600)
  })
  it('rebuilds decorations for one keystroke inside a frame budget', () => {
    const text = doc(3000)
    let state = EditorState.create({
      doc: text,
      extensions: [markdown({ base: markdownLanguage }), createMarkdownDecorations({})],
    })
    const samples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const position = 40 + index
      const started = performance.now()
      state = state.update({ changes: { from: position, insert: 'x' }, selection: { anchor: position + 1 } }).state
      samples.push(performance.now() - started)
    }
    samples.sort((left, right) => left - right)
    const p95 = samples[Math.floor(samples.length * 0.95)]
    // node 实测 avg 1.5ms / max 5.6ms；jsdom 放宽到两帧余量，拦的是 O(n²) 回退
    expect(p95).toBeLessThan(60)
  })
  it('scans a 10000 block (~1.2MB) document without quadratic blowup', () => {
    const text = doc(10_000)
    expect(text.length).toBeGreaterThan(1024 * 1024)
    expect(time(() => void scanMarkdown(text))).toBeLessThan(2500)
  })
})
