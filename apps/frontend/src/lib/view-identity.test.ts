import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetViewIdForTest, getViewId, isValidViewId } from './view-identity'

const STORAGE_KEY = 'tmuxgo.viewId.v1'

describe('view-identity', () => {
  beforeEach(() => {
    __resetViewIdForTest()
    window.localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __resetViewIdForTest()
    window.localStorage.clear()
  })

  it('generates a 32-char hex id on first use, persists it, and keeps it stable', () => {
    const first = getViewId()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(first)
    expect(getViewId()).toBe(first)
  })

  it('reuses a valid id already in localStorage without rewriting it', () => {
    const stored = 'Browser_View-01'
    window.localStorage.setItem(STORAGE_KEY, stored)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    expect(getViewId()).toBe(stored)
    expect(setItem).not.toHaveBeenCalled()
  })

  it.each(['short', 'has space inside it', 'x'.repeat(65), 'bad$chars'])(
    'regenerates when the stored value is invalid (%s)',
    (invalid) => {
      window.localStorage.setItem(STORAGE_KEY, invalid)
      const next = getViewId()
      expect(next).not.toBe(invalid)
      expect(isValidViewId(next)).toBe(true)
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(next)
    },
  )

  it('still returns a valid id when localStorage read/write throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(() => getViewId()).not.toThrow()
    const id = getViewId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(getViewId()).toBe(id)
  })

  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        for (let index = 0; index < array.length; index += 1) array[index] = 0xab
        return array
      },
    })
    expect(getViewId()).toBe('ab'.repeat(16))
  })

  it('falls back to Math.random when crypto is entirely unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    const id = getViewId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(id)
  })
})
