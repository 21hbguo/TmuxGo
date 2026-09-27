import { describe, expect, it } from 'vitest'
import { fileCategory, formatFileSize, summarizeCategories } from './file-meta'

describe('fileCategory', () => {
  it('classifies by extension first, case-insensitive', () => {
    expect(fileCategory({ name: 'a.PNG' })).toBe('image')
    expect(fileCategory({ name: 'clip.MP4' })).toBe('video')
    expect(fileCategory({ name: 'song.flac' })).toBe('audio')
    expect(fileCategory({ name: 'pack.tar.gz' })).toBe('archive')
    expect(fileCategory({ name: 'doc.pdf' })).toBe('document')
    expect(fileCategory({ name: 'main.ts' })).toBe('code')
    expect(fileCategory({ name: 'notes.md' })).toBe('text')
  })
  it('falls back to MIME for unknown/extensionless names', () => {
    expect(fileCategory({ name: 'blob', type: 'image/webp' })).toBe('image')
    expect(fileCategory({ name: 'x.weird', type: 'video/unknown' })).toBe('video')
    expect(fileCategory({ name: 'x.weird', type: 'audio/x-custom' })).toBe('audio')
    expect(fileCategory({ name: 'x.weird', type: 'application/zip' })).toBe('archive')
    expect(fileCategory({ name: 'x.weird', type: 'text/plain' })).toBe('text')
  })
  it('extension beats a misleading MIME', () => {
    expect(fileCategory({ name: 'app.py', type: 'text/plain' })).toBe('code')
  })
  it('returns other for unknown files', () => {
    expect(fileCategory({ name: 'Makefile' })).toBe('other')
    expect(fileCategory({ name: 'x.bin', type: 'application/octet-stream' })).toBe('other')
  })
})

describe('summarizeCategories', () => {
  it('groups counts in first-seen order', () => {
    const files = [{ name: 'b.py' }, { name: 'a.png' }, { name: 'c.png' }, { name: 'd.py' }]
    expect(summarizeCategories(files)).toEqual([
      ['code', 2],
      ['image', 2],
    ])
  })
  it('returns empty for no files', () => {
    expect(summarizeCategories([])).toEqual([])
  })
})

describe('formatFileSize', () => {
  it('formats B/KB/MB', () => {
    expect(formatFileSize(512)).toBe('512B')
    expect(formatFileSize(2048)).toBe('2KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3MB')
  })
})
