import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
// ActivityBar 的 fleet 角标读 react-query 缓存，渲染必须有 provider
const renderBar = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(React.createElement(QueryClientProvider, { client }, React.createElement(ActivityBar)))

describe('ActivityBar browser entry', () => {
  beforeEach(() => {
    useConsoleStore.setState({ activeHostId: 'local' })
  })

  it('disables the browser icon for remote hosts and explains why', () => {
    useConsoleStore.setState({ activeHostId: 'devbox' })
    renderBar()
    const browser = screen.getByRole('button', { name: 'Browser' }) as HTMLButtonElement
    expect(browser.disabled).toBe(true)
    expect(browser.title).toBe('Browser · Browser panel is local-only')
    // VNC 仍然可用（agent 中继/ssh 隧道），不能被一起置灰
    expect((screen.getByRole('button', { name: 'Desktop' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the browser icon clickable on the local host', () => {
    renderBar()
    expect((screen.getByRole('button', { name: 'Browser' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('ActivityBar fleet entry', () => {
  beforeEach(() => {
    useConsoleStore.setState({ activeHostId: 'local', fleetPanelOpen: false })
  })

  it('sits between sessions and files', () => {
    renderBar()
    const labels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    const sessions = labels.indexOf('activity.sessions')
    const fleet = labels.indexOf('activity.fleet')
    const files = labels.indexOf('activity.explorer')
    expect(sessions).toBeGreaterThanOrEqual(0)
    expect(fleet).toBeGreaterThan(sessions)
    expect(files).toBeGreaterThan(fleet)
  })

  it('badges only the blocked agents, not the total', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(
      ['sessions', 'local'],
      [
        {
          id: 'local:dev',
          hostId: 'local',
          name: 'dev',
          agents: [
            { paneId: 'local:%1', agentStatus: 'blocked' },
            { paneId: 'local:%2', agentStatus: 'working' },
          ],
        },
      ],
    )
    renderBar(client)
    const fleet = screen.getByRole('button', { name: 'activity.fleet' })
    await waitFor(() => expect(fleet.textContent).toContain('1'))
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
