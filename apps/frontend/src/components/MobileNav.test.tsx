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
        'nav.inbox': 'Inbox',
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
      onOpenInbox={vi.fn()}
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

  it('renders eight nav buttons including inbox and desktop', () => {
    const { container } = renderNav()
    expect(container.querySelector('.grid-cols-8')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Desktop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy()
    expect(container.querySelectorAll('.tmuxgo-mobile-nav-button')).toHaveLength(8)
  })

  it('invokes onOpenDesktop when the desktop entry is tapped', () => {
    const onOpenDesktop = vi.fn()
    renderNav({ onOpenDesktop })
    fireEvent.click(screen.getByRole('button', { name: 'Desktop' }))
    expect(onOpenDesktop).toHaveBeenCalledTimes(1)
  })

  it('invokes onOpenInbox and marks the entry active when open', () => {
    const onOpenInbox = vi.fn()
    renderNav({ onOpenInbox, inboxOpen: true })
    const inboxButton = screen.getByRole('button', { name: 'Inbox' })
    expect(inboxButton.getAttribute('aria-current')).toBe('page')
    expect(inboxButton.className).toContain('tmuxgo-mobile-nav-button--active')
    fireEvent.click(inboxButton)
    expect(onOpenInbox).toHaveBeenCalledTimes(1)
  })

  it('shows unread badge capped at 99+ and hides it at zero', () => {
    const { container, rerender } = render(
      <MobileNav
        onOpenDrawer={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenDesktop={vi.fn()}
        onOpenInbox={vi.fn()}
        inboxUnread={100}
      />,
    )
    expect(screen.getByText('99+')).toBeTruthy()
    rerender(
      <MobileNav
        onOpenDrawer={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenDesktop={vi.fn()}
        onOpenInbox={vi.fn()}
        inboxUnread={7}
      />,
    )
    expect(screen.getByText('7')).toBeTruthy()
    rerender(
      <MobileNav
        onOpenDrawer={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenDesktop={vi.fn()}
        onOpenInbox={vi.fn()}
        inboxUnread={0}
      />,
    )
    expect(container.querySelector('.bg-danger')).toBeNull()
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

  it('compact layout keeps panes in the main bar and routes inbox through the More sheet', () => {
    window.localStorage.setItem('tmuxgo-mobile-nav-compact', 'true')
    const onOpenGit = vi.fn()
    const onOpenFiles = vi.fn()
    const onOpenDrawer = vi.fn()
    const onOpenInbox = vi.fn()
    const { container } = renderNav({ onOpenGit, onOpenFiles, onOpenDrawer, onOpenInbox, gitOpen: true })
    // 底栏仅 会话/窗口/面板/更多 四列（面板高频直接上栏，收件箱进更多）
    expect(container.querySelector('.grid-cols-4')).toBeTruthy()
    expect(container.querySelector('.grid-cols-8')).toBeNull()
    expect(screen.getByRole('button', { name: 'Panes' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
    const moreButton = screen.getByRole('button', { name: 'More' })
    // 打开条目在更多组内 → More 也带选中反馈
    expect(moreButton.getAttribute('aria-current')).toBe('page')
    fireEvent.click(moreButton)
    const sheet = container.querySelector('[data-mobile-nav-more]') as HTMLElement
    expect(sheet).toBeTruthy()
    const gitEntry = screen.getByRole('button', { name: 'Git' })
    expect(gitEntry.getAttribute('aria-current')).toBe('page')
    fireEvent.click(gitEntry)
    expect(onOpenGit).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-mobile-nav-more]')).toBeNull()
    // 文件入口在更多面板
    fireEvent.click(moreButton)
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
    // 收件箱收进更多面板，点击仍走原入口
    fireEvent.click(moreButton)
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }))
    expect(onOpenInbox).toHaveBeenCalledTimes(1)
    // 底栏面板入口与原 drawer 语义一致
    fireEvent.click(screen.getByRole('button', { name: 'Panes' }))
    expect(onOpenDrawer).toHaveBeenCalledWith('panes')
  })

  it('layout toggle switches between compact and full bar and persists the choice', () => {
    const { container } = renderNav()
    expect(container.querySelector('.grid-cols-8')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compact bar' }))
    expect(window.localStorage.getItem('tmuxgo-mobile-nav-compact')).toBe('true')
    expect(container.querySelector('.grid-cols-4')).toBeTruthy()
    // 可回退：切回完整八项布局
    fireEvent.click(screen.getByRole('button', { name: 'Full bar' }))
    expect(window.localStorage.getItem('tmuxgo-mobile-nav-compact')).toBe('false')
    expect(container.querySelector('.grid-cols-8')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
  })
})
