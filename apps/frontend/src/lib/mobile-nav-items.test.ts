import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NAV_BAR_ITEMS_EVENT, NAV_BAR_ITEMS_KEY, readNavBarItems, writeNavBarItems } from './mobile-nav-items'

describe('mobile-nav-items', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to empty and ignores malformed payloads', () => {
    expect(readNavBarItems()).toEqual([])
    localStorage.setItem(NAV_BAR_ITEMS_KEY, 'not-json')
    expect(readNavBarItems()).toEqual([])
    localStorage.setItem(NAV_BAR_ITEMS_KEY, '"upload"')
    expect(readNavBarItems()).toEqual([])
  })

  it('keeps only known keys in fixed order', () => {
    localStorage.setItem(NAV_BAR_ITEMS_KEY, JSON.stringify(['files', 'bogus', 'upload', 'files']))
    expect(readNavBarItems()).toEqual(['upload', 'files'])
  })

  it('normalizes writes and notifies listeners', () => {
    const listener = vi.fn()
    window.addEventListener(NAV_BAR_ITEMS_EVENT, listener)
    writeNavBarItems(['git', 'nope', 'inbox'])
    expect(JSON.parse(localStorage.getItem(NAV_BAR_ITEMS_KEY) ?? '[]')).toEqual(['inbox', 'git'])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps session-consistent state when localStorage write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    writeNavBarItems(['git'])
    expect(readNavBarItems()).toEqual(['git'])
    vi.restoreAllMocks()
  })
})
