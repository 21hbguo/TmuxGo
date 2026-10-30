import { describe, expect, it } from 'vitest'
import { isPreviewableKind, previewKindForPath, rawPreviewSupported } from './file-preview'

describe('previewKindForPath', () => {
  it.each([
    ['notes.md', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['notes.mdx', 'markdown'],
    ['page.html', 'html'],
    ['page.htm', 'html'],
    ['page.xhtml', 'html'],
    ['data.csv', 'csv'],
    ['data.tsv', 'csv'],
    ['data.tab', 'csv'],
    ['doc.pdf', 'pdf'],
    ['photo.png', 'image'],
    ['photo.JPEG', 'image'],
    ['icon.svg', 'svg'],
    ['track.mp3', 'audio'],
    ['track.flac', 'audio'],
    ['clip.mp4', 'video'],
    ['clip.webm', 'video'],
    ['app.log', 'text'],
    ['main.ts', 'text'],
    ['blob.bin', 'binary'],
    ['README', 'binary'],
  ])('%s -> %s', (path, kind) => {
    expect(previewKindForPath(path)).toBe(kind)
  })

  it('ignores dots in directories and only looks at the basename', () => {
    expect(previewKindForPath('docs/v1.2/readme.md')).toBe('markdown')
    expect(previewKindForPath('a.b/c')).toBe('binary')
  })
})

describe('capability flags', () => {
  it('binary is the only non-previewable kind', () => {
    expect(isPreviewableKind('binary')).toBe(false)
    for (const kind of ['markdown', 'html', 'csv', 'pdf', 'image', 'audio', 'video', 'svg', 'text'] as const)
      expect(isPreviewableKind(kind)).toBe(true)
  })

  it('svg never goes through the raw stream (backend answers 415)', () => {
    expect(rawPreviewSupported('svg')).toBe(false)
    expect(rawPreviewSupported('markdown')).toBe(false)
    expect(rawPreviewSupported('csv')).toBe(false)
    for (const kind of ['pdf', 'image', 'audio', 'video', 'html', 'text'] as const)
      expect(rawPreviewSupported(kind)).toBe(true)
  })
})
