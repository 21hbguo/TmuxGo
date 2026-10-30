import { describe, expect, it } from 'vitest'
import { buildRawUrl } from './raw-url'

describe('buildRawUrl', () => {
  it('keeps path separators while encoding each segment', () => {
    const url = buildRawUrl('local', 'root-0', 'docs/a b/c.md')
    expect(url).toBe(`${window.location.origin}/api/hosts/local/files/raw/root-0/docs/a%20b/c.md`)
  })

  it('encodes non-ASCII names and reserved characters', () => {
    const url = buildRawUrl('local', 'root-0', '资料/报告 #1.pdf')
    expect(url).toContain('/files/raw/root-0/%E8%B5%84%E6%96%99/%E6%8A%A5%E5%91%8A%20%231.pdf')
  })

  it('collapses redundant slashes and trims the leading one', () => {
    expect(buildRawUrl('local', 'root-0', '/docs//a.txt')).toBe(
      `${window.location.origin}/api/hosts/local/files/raw/root-0/docs/a.txt`,
    )
  })

  it('adds download and cache-bust query params only when asked', () => {
    const base = `${window.location.origin}/api/hosts/local/files/raw/root-0/a.pdf`
    expect(buildRawUrl('local', 'root-0', 'a.pdf')).toBe(base)
    expect(buildRawUrl('local', 'root-0', 'a.pdf', { download: true })).toBe(`${base}?download=1`)
    expect(buildRawUrl('local', 'root-0', 'a.pdf', { v: '1699' })).toBe(`${base}?v=1699`)
    expect(buildRawUrl('local', 'root-0', 'a.pdf', { download: true, v: 'x y' })).toBe(`${base}?download=1&v=x+y`)
  })

  it('encodes host and root ids', () => {
    const url = buildRawUrl('host 1', 'root/2', 'a.txt')
    expect(url).toContain('/api/hosts/host%201/files/raw/root%2F2/a.txt')
  })
})
