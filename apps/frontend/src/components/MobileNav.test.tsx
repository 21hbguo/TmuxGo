import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

  it('always labels the settings entry as Settings while status stays separate', () => {
    renderNav()
    const settingsButton = screen.getByRole('button', { name: 'Settings' })
    // 设置按钮不再用延迟数字/省略号代替名称
    expect(settingsButton.textContent).toContain('Settings')
    expect(settingsButton.textContent).not.toContain('ms')
    // 连接状态独立展示在底栏状态行
    expect(screen.getByText('12/30ms')).toBeTruthy()
    act(() => {
      useConsoleStore.setState({
        connection: { status: 'disconnected', latency: 0, lastPing: '' },
      } as any)
    })
    expect(screen.getByText('Off')).toBeTruthy()
  })

  it('marks every open entry with aria-current and the active style', () => {
    const { container } = renderNav({
      sessionsOpen: true,
      filesOpen: true,
      gitOpen: true,
      settingsOpen: true,
    })
    for (const name of ['Sessions', 'Files', 'Git', 'Settings']) {
      const button = screen.getByRole('button', { name })
      expect(button.getAttribute('aria-current')).toBe('page')
      expect(button.className).toContain('tmuxgo-mobile-nav-button--active')
    }
    const inactive = screen.getByRole('button', { name: 'Desktop' })
    expect(inactive.getAttribute('aria-current')).toBeNull()
    expect(inactive.className).not.toContain('tmuxgo-mobile-nav-button--active')
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(4)
  })
})
