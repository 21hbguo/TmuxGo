import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityBar, orderActivityItems } from './ActivityBar'
import { useConsoleStore } from '@/stores/useConsoleStore'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'browser.title': 'Browser',
        'browser.localOnly': 'Browser panel is local-only',
        'vnc.title': 'Desktop',
      }
      return map[key] || key
    },
  }),
}))
vi.mock('@/hooks/useApi', () => ({ usePlugins: () => ({ data: { plugins: [] } }) }))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: {}, updatePreferences: vi.fn() }),
}))

const items = (...ids: string[]) => ids.map((id) => ({ id }))

describe('ActivityBar browser entry', () => {
  beforeEach(() => {
    useConsoleStore.setState({ activeHostId: 'local' })
  })

  it('disables the browser icon for remote hosts and explains why', () => {
    useConsoleStore.setState({ activeHostId: 'devbox' })
    render(<ActivityBar />)
    const browser = screen.getByRole('button', { name: 'Browser' }) as HTMLButtonElement
    expect(browser.disabled).toBe(true)
    expect(browser.title).toBe('Browser · Browser panel is local-only')
    // VNC 仍然可用（agent 中继/ssh 隧道），不能被一起置灰
    expect((screen.getByRole('button', { name: 'Desktop' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the browser icon clickable on the local host', () => {
    render(<ActivityBar />)
    expect((screen.getByRole('button', { name: 'Browser' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('orderActivityItems', () => {
  it('keeps natural order when no saved order exists', () => {
    expect(orderActivityItems(items('a', 'b'), []).map((i) => i.id)).toEqual(['a', 'b'])
  })
  it('applies saved order and drops unknown ids', () => {
    expect(orderActivityItems(items('a', 'b', 'c'), ['c', 'ghost', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })
  it('appends new items after saved order', () => {
    expect(orderActivityItems(items('a', 'b', 'plugin:x:y'), ['b']).map((i) => i.id)).toEqual(['b', 'a', 'plugin:x:y'])
  })
  it('dedupes repeated ids in saved order', () => {
    expect(orderActivityItems(items('a', 'b'), ['b', 'b', 'a']).map((i) => i.id)).toEqual(['b', 'a'])
  })
})
