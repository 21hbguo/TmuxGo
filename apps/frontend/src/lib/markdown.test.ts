import { describe, expect, it } from 'vitest'
import { locatePreviewBlock, renderMarkdown, renderMarkdownDocument } from './markdown'

const ctx = { hostId: 'local', rootId: 'workspace', filePath: 'docs/readme.md' }

describe('renderMarkdown line annotation', () => {
  it('annotates headings and paragraphs with source line numbers', () => {
    const html = renderMarkdown('# 标题\n\n第一段\n\n第二段')
    // 标题现在同时带 slug id（headingIds 默认 true），断言只锁 data-line 前缀
    expect(html).toContain('<h1 data-line="1" id="标题">')
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

describe('renderMarkdown images', () => {
  it('rewrites a relative image into a placeholder plus data-md metadata', () => {
    const html = renderMarkdown('![](./pic.png)', { asset: ctx })
    expect(html).toContain('data-md-src="./pic.png"')
    expect(html).toContain('data-md-path="docs/pic.png"')
    expect(html).toContain('data-md-kind="relative"')
    expect(html).toContain('src="data:image/gif;base64,')
    expect(html).not.toContain('data-md-state')
  })
  it('treats a leading slash as root-relative', () => {
    const html = renderMarkdown('![](/abs/x.png)', { asset: ctx })
    expect(html).toContain('data-md-path="abs/x.png"')
    expect(html).toContain('data-md-kind="root-absolute"')
  })
  it('decodes CJK and spaces before building the path', () => {
    const html = renderMarkdown('![](<./中文 图.png>)', { asset: ctx })
    expect(html).toContain('data-md-path="docs/中文 图.png"')
    // marked 的 token.href 已解码，data-md-src 就是源码里那串可读路径
    expect(html).toContain('data-md-src="./中文 图.png"')
  })
  it('keeps external images direct with lazy loading and no referrer', () => {
    const html = renderMarkdown('![](https://example.com/a.png)', { asset: ctx })
    expect(html).toContain('src="https://example.com/a.png"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain('data-md-kind="external"')
  })
  it('marks escaping paths as unsupported instead of building a request', () => {
    const html = renderMarkdown('![](../../secret.png)', { asset: ctx })
    expect(html).toContain('data-md-state="unsupported"')
    expect(html).toContain('data-md-reason="outside-root"')
    expect(html).not.toContain('data-md-path')
  })
  it('marks local images unsupported when no asset context exists', () => {
    const html = renderMarkdown('![](./pic.png)')
    expect(html).toContain('data-md-state="unsupported"')
    expect(html).toContain('data-md-reason="missing-context"')
  })
  it('never emits a javascript: image src', () => {
    const html = renderMarkdown('![](javascript:alert(1))', { asset: ctx })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('data-md-reason="unsafe-scheme"')
  })
  it('keeps width/height/title from inline HTML images', () => {
    const html = renderMarkdown('<img src="./pic.png" width="200" height="100" title="图">', { asset: ctx })
    expect(html).toContain('width="200"')
    expect(html).toContain('height="100"')
    expect(html).toContain('title="图"')
  })
  it('reports resolved image refs in document order', () => {
    const { images } = renderMarkdownDocument('![](./a.png)\n\n![](https://x/b.png)', { asset: ctx })
    expect(images.map((item) => [item.kind, item.resolvedPath])).toEqual([
      ['relative', 'docs/a.png'],
      ['external', null],
    ])
  })
})

describe('renderMarkdown links and headings', () => {
  it('opens http(s) links in a new tab with a marker attribute', () => {
    const html = renderMarkdown('[官网](https://example.com/docs)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('data-md-external="1"')
    expect(html).toContain('href="https://example.com/docs"')
  })
  it('leaves in-page anchors untouched', () => {
    const html = renderMarkdown('[跳转](#章节)')
    expect(html).toContain('href="#章节"')
    expect(html).not.toContain('data-md-external')
  })
  it('drops javascript: links', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })
  it('adds stable GitHub-style heading ids and dedupes duplicates', () => {
    const { html, headings } = renderMarkdownDocument('# Hello World\n\n## Hello World\n\n### 中文 标题')
    expect(html).toContain('id="hello-world"')
    expect(html).toContain('id="hello-world-1"')
    expect(html).toContain('id="中文-标题"')
    expect(headings).toEqual([
      { id: 'hello-world', text: 'Hello World', line: 1 },
      { id: 'hello-world-1', text: 'Hello World', line: 3 },
      { id: '中文-标题', text: '中文 标题', line: 5 },
    ])
  })
  it('strips inline formatting before slugging', () => {
    const { headings } = renderMarkdownDocument('## Hello **World** `code` [link](./x)')
    expect(headings[0].id).toBe('hello-world-code-link')
    expect(headings[0].text).toBe('Hello World code link')
  })
  it('can disable heading ids', () => {
    const html = renderMarkdown('# 标题', { headingIds: false })
    expect(html).not.toContain('id=')
    expect(html).toContain('<h1 data-line="1">')
  })
})

describe('renderMarkdown sanitization', () => {
  it('forbids style/form/iframe/object/embed/link/meta/base', () => {
    const html = renderMarkdown(
      '<style>body{color:red}</style>\n\n<form action="/x"><input name="a"></form>\n\n<iframe src="https://x"></iframe>\n\n<object data="x"></object>\n\n<embed src="x">',
    )
    for (const tag of ['<style', '<form', '<iframe', '<object', '<embed', '<link', '<meta', '<base']) {
      expect(html).not.toContain(tag)
    }
  })
  it('strips inline style attributes', () => {
    const html = renderMarkdown('<div style="position:fixed;top:0">x</div>')
    expect(html).not.toContain('style=')
  })
  it('keeps gfm task list checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
  })
})

describe('renderMarkdown code block segmentation', () => {
  it('does not inject <br> inside tilde fences', () => {
    const html = renderMarkdown('~~~js\nconst a = 1\n\n\nconst b = 2\n~~~')
    expect(html).toContain('<pre data-line="1">')
    expect(html).not.toContain('<br>')
    expect(html).toContain('const a = 1')
    expect(html).toContain('const b = 2')
  })
  it('does not inject <br> inside an unclosed fence', () => {
    const html = renderMarkdown('```\na\n\n\nb')
    expect(html).not.toContain('<br>')
  })
  it('does not inject <br> inside 4-space indented code blocks', () => {
    const html = renderMarkdown('段落\n\n    line1\n\n\n    line2\n\n结尾')
    expect(html).toContain('<pre data-line="3">')
    expect(html).not.toContain('<br>')
    expect(html).toContain('line1')
    expect(html).toContain('line2')
    expect(html).toContain('结尾')
  })
  it('still collapses blank lines in prose around code blocks', () => {
    const html = renderMarkdown('前\n\n\n后\n\n```\nx\n```')
    expect(html).toContain('前<br>')
  })
  it('keeps line numbers aligned after code segments', () => {
    const html = renderMarkdown('```\na\n```\n\n第二段')
    expect(html).toContain('<pre data-line="1">')
    expect(html).toContain('<p data-line="5">')
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
