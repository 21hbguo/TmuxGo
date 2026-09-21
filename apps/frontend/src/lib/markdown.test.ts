import { describe, expect, it } from 'vitest'
import { locatePreviewBlock, renderMarkdown } from './markdown'
describe('renderMarkdown line annotation', () => {
  it('annotates headings and paragraphs with source line numbers', () => {
    const html = renderMarkdown('# 标题\n\n第一段\n\n第二段')
    expect(html).toContain('<h1 data-line="1">')
    expect(html).toContain('<p data-line="3">')
    expect(html).toContain('<p data-line="5">')
  })
  it('annotates list items, code blocks and blockquotes', () => {
    const html = renderMarkdown('- a\n- b\n\n```ts\nconst x = 1\n```\n\n> 引用')
    expect(html).toContain('<li data-line="1">')
    expect(html).toContain('<li data-line="2">')
    expect(html).toContain('<pre data-line="4">')
    expect(html).toContain('<blockquote data-line="8">')
  })
  it('keeps rendering output stable with gfm tables and images', () => {
    const html = renderMarkdown('# 标题\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n\n![图](https://example.com/a.png)')
    expect(html).toContain('<table data-line="3">')
    expect(html).toContain('<img src="https://example.com/a.png"')
  })
  it('keeps empty-line preservation inside paragraphs', () => {
    const html = renderMarkdown('前\n\n\n中\n\n\n\n后')
    expect(html).toContain('<p data-line="1">')
    expect(html).toContain('前<br>')
  })
})
describe('locatePreviewBlock', () => {
  it('returns the last block whose data-line is at or above the cursor line', () => {
    const article = document.createElement('article')
    article.innerHTML = renderMarkdown('# 标题\n\n第一段\n\n第二段')
    const [h1, p1, p2] = Array.from(article.querySelectorAll<HTMLElement>('[data-line]'))
    expect(locatePreviewBlock(article, 3)).toBe(p1)
    expect(locatePreviewBlock(article, 4)).toBe(p1)
    expect(locatePreviewBlock(article, 5)).toBe(p2)
    expect(locatePreviewBlock(article, 1)).toBe(h1)
  })
  it('falls back to the first block when the cursor is above it', () => {
    const article = document.createElement('article')
    article.innerHTML = '<p data-line="4">四行</p><p data-line="8">八行</p>'
    const first = article.querySelector<HTMLElement>('[data-line="4"]')
    expect(locatePreviewBlock(article, 1)).toBe(first)
    expect(locatePreviewBlock(article, 3)).toBe(first)
  })
  it('returns null when the article has no annotated blocks', () => {
    const article = document.createElement('article')
    article.innerHTML = '<p>plain</p>'
    expect(locatePreviewBlock(article, 5)).toBeNull()
  })
})
