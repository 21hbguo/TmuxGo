import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NAV_BAR_ITEMS_KEY, readNavBarItems, writeNavBarItems } from './mobile-nav-items'

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
    window.addEventListener('tmuxgo-nav-bar-items-changed', listener)
    writeNavBarItems(['git', 'nope', 'inbox'])
    expect(JSON.parse(localStorage.getItem(NAV_BAR_ITEMS_KEY) ?? '[]')).toEqual(['inbox', 'git'])
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
