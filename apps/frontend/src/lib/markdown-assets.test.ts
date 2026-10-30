import { describe, expect, it } from 'vitest'
import { classifyImageSrc, isIndentedCodeLine, resolveImageRef, type MarkdownAssetContext } from './markdown-assets'

const ctx: MarkdownAssetContext = { hostId: 'local', rootId: 'workspace', filePath: 'docs/readme.md' }

describe('classifyImageSrc', () => {
  it('classifies the five supported kinds', () => {
    expect(classifyImageSrc('./pic.png')).toBe('relative')
    expect(classifyImageSrc('sub/pic.png')).toBe('relative')
    expect(classifyImageSrc('/abs/x.png')).toBe('root-absolute')
    expect(classifyImageSrc('https://example.com/a.png')).toBe('external')
    expect(classifyImageSrc('http://example.com/a.png')).toBe('external')
    expect(classifyImageSrc('//cdn.example.com/a.png')).toBe('external')
    expect(classifyImageSrc('data:image/png;base64,AAAA')).toBe('data')
  })
  it('rejects dangerous or unknown schemes and empty input', () => {
    expect(classifyImageSrc('javascript:alert(1)')).toBe('invalid')
    expect(classifyImageSrc('JavaScript:alert(1)')).toBe('invalid')
    expect(classifyImageSrc('file:///home/user/x.png')).toBe('invalid')
    expect(classifyImageSrc('vbscript:msgbox(1)')).toBe('invalid')
    expect(classifyImageSrc('')).toBe('invalid')
    expect(classifyImageSrc('   ')).toBe('invalid')
  })
  it('treats data: URIs that are not images as invalid', () => {
    expect(classifyImageSrc('data:text/html,<script>alert(1)</script>')).toBe('invalid')
  })
})

describe('resolveImageRef', () => {
  it('resolves a relative path against the markdown file directory', () => {
    const ref = resolveImageRef('./pic.png', ctx)
    expect(ref).toMatchObject({ kind: 'relative', src: './pic.png', rawSrc: './pic.png', resolvedPath: 'docs/pic.png' })
    expect(ref.reason).toBeUndefined()
  })
  it('resolves relative climb inside the root', () => {
    expect(resolveImageRef('../assets/x.png', ctx).resolvedPath).toBe('assets/x.png')
  })
  it('marks climbs that escape the root as outside-root', () => {
    const ref = resolveImageRef('../../x.png', ctx)
    expect(ref.resolvedPath).toBeNull()
    expect(ref.reason).toBe('outside-root')
  })
  it('treats a leading slash as root-relative', () => {
    expect(resolveImageRef('/abs/x.png', ctx)).toMatchObject({ kind: 'root-absolute', resolvedPath: 'abs/x.png' })
    expect(resolveImageRef('/../x.png', ctx).reason).toBe('outside-root')
  })
  it('decodes percent-encoded CJK and spaces for local paths', () => {
    const cjk = resolveImageRef('./%E5%9B%BE%E7%89%87.png', ctx)
    expect(cjk.src).toBe('./图片.png')
    expect(cjk.resolvedPath).toBe('docs/图片.png')
    const spaced = resolveImageRef('./a%20b.png', ctx)
    expect(spaced.src).toBe('./a b.png')
    expect(spaced.resolvedPath).toBe('docs/a b.png')
  })
  it('keeps remote src verbatim (decoding would corrupt the URL) and never resolves a path', () => {
    const ref = resolveImageRef('https://example.com/a%20b.png', ctx)
    expect(ref).toMatchObject({ kind: 'external', src: 'https://example.com/a%20b.png', resolvedPath: null })
    expect(resolveImageRef('data:image/png;base64,AAAA', ctx).resolvedPath).toBeNull()
  })
  it('reports unsafe-scheme for javascript: images', () => {
    expect(resolveImageRef('javascript:alert(1)', ctx)).toMatchObject({
      kind: 'invalid',
      resolvedPath: null,
      reason: 'unsafe-scheme',
    })
  })
  it('reports missing-context when no asset context is supplied', () => {
    expect(resolveImageRef('./pic.png')).toMatchObject({ resolvedPath: null, reason: 'missing-context' })
    // 远程/内联不需要上下文
    expect(resolveImageRef('https://example.com/a.png').reason).toBeUndefined()
  })
  it('normalizes windows separators and root-level files', () => {
    expect(resolveImageRef('.\\sub\\x.png', { ...ctx, filePath: 'readme.md' }).resolvedPath).toBe('sub/x.png')
    expect(resolveImageRef('pic.png', { ...ctx, filePath: 'readme.md' }).resolvedPath).toBe('pic.png')
  })
})

describe('isIndentedCodeLine', () => {
  it('accepts 4 spaces or a tab', () => {
    expect(isIndentedCodeLine('    const x = 1')).toBe(true)
    expect(isIndentedCodeLine('\tconst x = 1')).toBe(true)
    expect(isIndentedCodeLine('   three spaces')).toBe(false)
    expect(isIndentedCodeLine('')).toBe(false)
  })
  it('does not treat indented list items as code', () => {
    expect(isIndentedCodeLine('    - nested item')).toBe(false)
    expect(isIndentedCodeLine('    1. nested item')).toBe(false)
  })
})
