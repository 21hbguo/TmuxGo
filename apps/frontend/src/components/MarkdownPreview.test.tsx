import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreview, type MarkdownPreviewLabels } from './MarkdownPreview'
import { renderMarkdown } from '@/lib/markdown'

const labels: MarkdownPreviewLabels = {
  imageFailed: '图片加载失败',
  imageUnavailable: '不支持该路径',
  copyCode: '复制代码',
  copied: '已复制',
}
const ctx = { hostId: 'local', rootId: 'workspace', filePath: 'docs/readme.md' }

describe('MarkdownPreview images', () => {
  it('replaces a local placeholder with the loaded blob URL', async () => {
    const html = renderMarkdown('![](./pic.png)', { asset: ctx })
    const loadImage = vi.fn(async () => 'blob:local-1')
    render(<MarkdownPreview html={html} loadImage={loadImage} labels={labels} />)
    const img = document.querySelector('img') as HTMLImageElement
    await waitFor(() => expect(img.getAttribute('data-md-loaded')).toBe('1'))
    expect(loadImage).toHaveBeenCalledWith('./pic.png')
    expect(img.src).toBe('blob:local-1')
  })
  it('swaps in a fallback card when the image cannot be loaded', async () => {
    const html = renderMarkdown('![](./missing.png)', { asset: ctx })
    render(<MarkdownPreview html={html} loadImage={vi.fn(async () => null)} labels={labels} />)
    const fallback = await screen.findByText(labels.imageFailed)
    expect(fallback.closest('[data-md-image-fallback]')).not.toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
  it('renders the fallback immediately for unsupported paths without loading', async () => {
    const html = renderMarkdown('![](../../secret.png)', { asset: ctx })
    const loadImage = vi.fn(async () => 'blob:never')
    render(<MarkdownPreview html={html} loadImage={loadImage} labels={labels} />)
    const fallback = await screen.findByText(labels.imageUnavailable)
    expect(fallback.closest('[data-md-image-fallback]')?.getAttribute('data-md-image-fallback')).toBe('unsupported')
    expect(loadImage).not.toHaveBeenCalled()
  })
  it('keeps external images as-is', async () => {
    const html = renderMarkdown('![](https://example.com/a.png)', { asset: ctx })
    const loadImage = vi.fn(async () => 'blob:never')
    render(<MarkdownPreview html={html} loadImage={loadImage} labels={labels} />)
    const img = document.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://example.com/a.png')
    expect(loadImage).not.toHaveBeenCalled()
  })
  it('shows the unavailable card when no loader is provided', async () => {
    const html = renderMarkdown('![](./pic.png)', { asset: ctx })
    render(<MarkdownPreview html={html} labels={labels} />)
    expect(await screen.findByText(labels.imageUnavailable)).toBeTruthy()
  })
})

describe('MarkdownPreview interactions', () => {
  it('reports the source line on double click', () => {
    const html = renderMarkdown('# 标题\n\n正文')
    const onJump = vi.fn()
    render(<MarkdownPreview html={html} labels={labels} onJump={onJump} />)
    fireEvent.doubleClick(screen.getByText('正文'))
    expect(onJump).toHaveBeenCalledWith(3)
  })
  it('intercepts external links instead of navigating', () => {
    const html = renderMarkdown('[官网](https://example.com/docs)')
    const onOpenExternal = vi.fn()
    render(<MarkdownPreview html={html} labels={labels} onOpenExternal={onOpenExternal} />)
    const link = screen.getByRole('link')
    fireEvent.click(link)
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/docs')
  })
  it('leaves anchor links alone', () => {
    const html = renderMarkdown('[跳转](#章节)')
    const onOpenExternal = vi.fn()
    render(<MarkdownPreview html={html} labels={labels} onOpenExternal={onOpenExternal} />)
    fireEvent.click(screen.getByRole('link'))
    expect(onOpenExternal).not.toHaveBeenCalled()
  })
  it('adds one copy button per code block and copies its text', async () => {
    const html = renderMarkdown('```js\nconst x = 1\n```\n\n```ts\nconst y = 2\n```')
    const onCopyCode = vi.fn()
    render(<MarkdownPreview html={html} labels={labels} onCopyCode={onCopyCode} />)
    const buttons = document.querySelectorAll('button[data-md-copy]')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].getAttribute('aria-label')).toBe(labels.copyCode)
    fireEvent.click(buttons[0])
    expect(onCopyCode).toHaveBeenCalledWith('const x = 1\n')
    expect(buttons[0].textContent).toBe(labels.copied)
  })
  it('renders with the default test id and a custom class', () => {
    const { rerender } = render(<MarkdownPreview html="<p>x</p>" labels={labels} />)
    expect(screen.getByTestId('markdown-preview')).toBeTruthy()
    rerender(<MarkdownPreview html="<p>x</p>" labels={labels} testId="md-custom" className="extra" />)
    expect(screen.getByTestId('md-custom').className).toBe('extra')
  })
})
