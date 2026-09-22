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
        'nav.more': 'More',
        'nav.compactBar': 'Compact bar',
        'nav.fullBar': 'Full bar',
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
    window.localStorage.clear()
    useConsoleStore.setState({
      connection: { status: 'connected', latency: 12, lastPing: '' },
      terminalPerf: { attachLatency: 30 },
    } as any)
  })

  it('renders a desktop entry among the seven nav buttons', () => {
    const { container } = renderNav()
    expect(container.querySelector('.grid-cols-7')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Desktop' })).toBeTruthy()
    expect(container.querySelectorAll('.tmuxgo-mobile-nav-button')).toHaveLength(7)
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

  it('compact layout keeps four entries and routes the rest through the More sheet', () => {
    window.localStorage.setItem('tmuxgo-mobile-nav-compact', 'true')
    const onOpenGit = vi.fn()
    const onOpenDrawer = vi.fn()
    const { container } = renderNav({ onOpenGit, onOpenDrawer, gitOpen: true })
    // 底栏仅 会话/窗口/文件/更多 四列
    expect(container.querySelector('.grid-cols-4')).toBeTruthy()
    expect(container.querySelector('.grid-cols-7')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Panes' })).toBeNull()
    const moreButton = screen.getByRole('button', { name: 'More' })
    // 打开面板在更多组内 → More 也带选中反馈
    expect(moreButton.getAttribute('aria-current')).toBe('page')
    fireEvent.click(moreButton)
    const sheet = container.querySelector('[data-mobile-nav-more]') as HTMLElement
    expect(sheet).toBeTruthy()
    const gitEntry = screen.getByRole('button', { name: 'Git' })
    expect(gitEntry.getAttribute('aria-current')).toBe('page')
    fireEvent.click(gitEntry)
    expect(onOpenGit).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-mobile-nav-more]')).toBeNull()
    // 更多面板内的窗格入口与原 drawer 语义一致
    fireEvent.click(moreButton)
    fireEvent.click(screen.getByRole('button', { name: 'Panes' }))
    expect(onOpenDrawer).toHaveBeenCalledWith('panes')
  })

  it('layout toggle switches between compact and full bar and persists the choice', () => {
    const { container } = renderNav()
    expect(container.querySelector('.grid-cols-7')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compact bar' }))
    expect(window.localStorage.getItem('tmuxgo-mobile-nav-compact')).toBe('true')
    expect(container.querySelector('.grid-cols-4')).toBeTruthy()
    // 可回退：切回完整七项布局
    fireEvent.click(screen.getByRole('button', { name: 'Full bar' }))
    expect(window.localStorage.getItem('tmuxgo-mobile-nav-compact')).toBe('false')
    expect(container.querySelector('.grid-cols-7')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
  })
})
