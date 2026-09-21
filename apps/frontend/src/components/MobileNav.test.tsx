import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNav } from './MobileNav'
import { useConsoleStore } from '@/stores/useConsoleStore'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'nav.sessions': 'Sessions',
        'nav.windows': 'Windows',
        'nav.panes': 'Panes',
        'nav.files': 'Files',
        'nav.git': 'Git',
        'nav.settings': 'Settings',
        'nav.off': 'Off',
        'vnc.title': 'Desktop',
      }
      return map[key] || key
    },
  }),
}))

const renderNav = (overrides: Record<string, unknown> = {}) =>
  render(
    <MobileNav
      onOpenDrawer={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenFiles={vi.fn()}
      onOpenGit={vi.fn()}
      onOpenDesktop={vi.fn()}
      {...overrides}
    />,
  )

describe('MobileNav', () => {
  beforeEach(() => {
    useConsoleStore.setState({
      connection: { status: 'connected', latency: 12, lastPing: '' },
      terminalPerf: { attachLatency: 30 },
    } as any)
  })

  it('renders a desktop entry among the seven nav buttons', () => {
    const { container } = renderNav()
    expect(container.querySelector('.grid-cols-7')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Desktop' })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(7)
  })

  it('invokes onOpenDesktop when the desktop entry is tapped', () => {
    const onOpenDesktop = vi.fn()
    renderNav({ onOpenDesktop })
    fireEvent.click(screen.getByRole('button', { name: 'Desktop' }))
    expect(onOpenDesktop).toHaveBeenCalledTimes(1)
  })
})
