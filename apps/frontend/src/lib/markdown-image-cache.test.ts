import { describe, expect, it, vi } from 'vitest'
import { createMarkdownImageLoader } from './markdown-image-cache'

const ctx = { hostId: 'local', rootId: 'workspace', filePath: 'docs/readme.md' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createMarkdownImageLoader', () => {
  it('fetches a local image once per src and returns an object URL', async () => {
    const fetchImage = vi.fn(async (_path: string) => new Blob(['img']))
    const loader = createMarkdownImageLoader(ctx, {
      fetchImage,
      createObjectUrl: () => 'blob:one',
      revokeObjectUrl: () => {},
    })
    const [a, b] = await Promise.all([loader.load('./pic.png'), loader.load('./pic.png')])
    expect(a).toBe('blob:one')
    expect(b).toBe('blob:one')
    expect(fetchImage).toHaveBeenCalledTimes(1)
    // 路径必须是 root 相对，且由 imageUrl 编码进 query
    const path = fetchImage.mock.calls[0][0]
    expect(path).toContain('/api/hosts/local/files/image')
    expect(path).toContain('root=workspace')
    expect(path).toContain('path=docs%2Fpic.png')
  })
  it('passes external and data sources through without fetching', async () => {
    const fetchImage = vi.fn(async () => new Blob([]))
    const loader = createMarkdownImageLoader(ctx, { fetchImage, createObjectUrl: () => 'blob:x' })
    await expect(loader.load('https://example.com/a.png')).resolves.toBe('https://example.com/a.png')
    await expect(loader.load('data:image/png;base64,AAAA')).resolves.toBe('data:image/png;base64,AAAA')
    expect(fetchImage).not.toHaveBeenCalled()
  })
  it('returns null for paths it must not request (escape / unsafe scheme)', async () => {
    const fetchImage = vi.fn(async () => new Blob([]))
    const loader = createMarkdownImageLoader(ctx, { fetchImage })
    await expect(loader.load('../../secret.png')).resolves.toBeNull()
    await expect(loader.load('javascript:alert(1)')).resolves.toBeNull()
    expect(fetchImage).not.toHaveBeenCalled()
  })
  it('caps concurrent requests at 3', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<Blob>>>()
    let inFlight = 0
    let peak = 0
    const fetchImage = vi.fn((path: string) => {
      const gate = deferred<Blob>()
      gates.set(path, gate)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return gate.promise.finally(() => {
        inFlight -= 1
      })
    })
    const loader = createMarkdownImageLoader(ctx, {
      fetchImage,
      createObjectUrl: (_blob) => `blob:${gates.size}`,
    })
    const loads = Array.from({ length: 6 }, (_, index) => loader.load(`./p${index}.png`))
    await Promise.resolve()
    expect(peak).toBe(3)
    // 逐个放行，队列才会继续推进
    for (let index = 0; index < 6; index += 1) {
      const gate = gates.get([...gates.keys()][index])
      expect(gate).toBeDefined()
      gate!.resolve(new Blob([String(index)]))
      await Promise.resolve()
      await Promise.resolve()
    }
    const results = await Promise.all(loads)
    expect(results.every((url) => typeof url === 'string')).toBe(true)
    expect(peak).toBeLessThanOrEqual(3)
  })
  it('resolves null instead of throwing when the request fails', async () => {
    const loader = createMarkdownImageLoader(ctx, {
      fetchImage: vi.fn(async () => {
        throw new Error('HTTP 500')
      }),
    })
    await expect(loader.load('./pic.png')).resolves.toBeNull()
  })
  it('revokes every created object URL on dispose and stops loading afterwards', async () => {
    const revoked: string[] = []
    let counter = 0
    const loader = createMarkdownImageLoader(ctx, {
      fetchImage: async () => new Blob([]),
      createObjectUrl: () => `blob:${(counter += 1)}`,
      revokeObjectUrl: (url) => revoked.push(url),
    })
    await loader.load('./a.png')
    await loader.load('./b.png')
    loader.dispose()
    expect(revoked.sort()).toEqual(['blob:1', 'blob:2'])
    await expect(loader.load('./c.png')).resolves.toBeNull()
  })
})
