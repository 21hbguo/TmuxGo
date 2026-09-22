import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'

const selectWindow = vi.fn()
const snapshotGet = vi.fn()
const invokePluginAction = vi.fn()
let plugins: any[] = []

vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  usePlugins: () => ({ data: { plugins } }),
  useInvokePluginAction: () => ({ mutateAsync: invokePluginAction }),
  useWindows: () => ({
    data: [
      { id: 'local:@1', sessionId: 'session-dev', index: 0, name: 'Main', active: true },
      { id: 'local:@2', sessionId: 'session-dev', index: 1, name: 'Logs', active: false },
    ],
  }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({
    data: [{ id: 'session-dev', hostId: 'local', name: 'Dev', createdAt: '', lastActiveAt: '', windowCount: 2 }],
  }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({
    getWindows: () => [
      { id: 'local:@1', sessionId: 'session-dev', index: 0, name: 'Main', active: true },
      { id: 'local:@2', sessionId: 'session-dev', index: 1, name: 'Logs', active: false },
    ],
    setWindows: vi.fn(),
  }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    windows: { select: (...args: any[]) => selectWindow(...args) },
    snapshot: { get: (...args: any[]) => snapshotGet(...args) },
  },
}))

describe('CommandPalette', () => {
  beforeEach(() => {
    localStorage.setItem('tmuxgo-preferences', JSON.stringify({ language: 'en' }))
    selectWindow.mockReset()
    snapshotGet.mockReset()
    invokePluginAction.mockReset()
    plugins = []
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev',
      activePaneId: 'local:%old',
      sessionPanelExpanded: true,
      filePanelOpen: false,
      showCommandPalette: true,
      toasts: [],
      connection: { status: 'disconnected', latency: 0, lastPing: new Date().toISOString() },
    } as any)
  })

  it('supports keyboard selection for session items', async () => {
    const user = userEvent.setup()
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} })))
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.click(input)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(useConsoleStore.getState().activeSessionId).toBe('session-dev')
  })
  it('syncs active pane after switching window', async () => {
    const user = userEvent.setup()
    selectWindow.mockResolvedValue({
      ok: true,
      windows: [
        { id: 'local:@1', sessionId: 'session-dev', index: 0, name: 'Main', active: false },
        { id: 'local:@2', sessionId: 'session-dev', index: 1, name: 'Logs', active: true },
      ],
    })
    snapshotGet.mockResolvedValue({
      windows: [],
      panes: [{ id: 'local:%new', active: true }],
      activePaneId: 'local:%new',
    })
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} })))
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.click(input)
    await user.type(input, 'logs')
    await user.keyboard('{Enter}')
    expect(selectWindow).toHaveBeenCalledWith('local', 'session-dev', 'local:@2')
    expect(snapshotGet).toHaveBeenCalledWith('local', 'session-dev')
    expect(useConsoleStore.getState().activePaneId).toBe('local:%new')
  })
  it('matches Chinese synonyms for split actions', async () => {
    const user = userEvent.setup()
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} })))
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.type(input, '分屏')
    expect(screen.getByText('Split pane horizontal')).toBeTruthy()
    expect(screen.getByText('Split pane vertical')).toBeTruthy()
    expect(screen.queryByText('Kill active window')).toBeNull()
  })
  it('orders sessions first and keeps dangerous actions last on empty query', () => {
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} })))
    const itemButtons = [...document.body.querySelectorAll('button.w-full')]
    expect(itemButtons[0]?.textContent).toContain('Dev')
    expect(itemButtons.at(-1)?.textContent).toContain('Kill active window')
  })
  it('scrolls the selected item into view on arrow keys', async () => {
    const user = userEvent.setup()
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} })))
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.click(input)
    await user.keyboard('{ArrowDown}')
    expect(scrollSpy).toHaveBeenCalled()
    expect(document.body.querySelector('[data-selected="true"]')?.textContent).toContain('Switch window: Main')
  })
  it('lists and invokes active plugin actions with the current context', async () => {
    const user = userEvent.setup()
    plugins = [
      {
        pluginId: 'test.plugin',
        enabled: true,
        state: 'active',
        manifest: {
          name: 'Test Plugin',
          contributes: { actions: [{ id: 'inspect', title: 'Inspect Context', command: ['test'] }] },
        },
      },
    ]
    invokePluginAction.mockResolvedValue({ status: 'success', stdout: 'plugin complete', stderr: '' })
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} })))
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.type(input, 'inspect')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(invokePluginAction).toHaveBeenCalledWith({
        pluginId: 'test.plugin',
        actionId: 'inspect',
        context: { hostId: 'local', sessionId: 'session-dev', paneId: 'local:%old', source: 'command-palette' },
      }),
    )
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('plugin complete')
  })
  it('does not consume Enter, arrows or Escape during IME composition', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose })))
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.click(input)
    // 拼音选词键（isComposing 或 keyCode 229 两种上报路径都要拦）
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Process' })
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 229, isComposing: true })
    fireEvent.keyDown(input, { key: 'ArrowUp', keyCode: 229, isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229, isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    expect(selectWindow).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-selected="true"]')?.textContent).toContain('Dev')
  })
  it('resumes normal key handling once composition ends', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose })))
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.click(input)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.body.querySelector('[data-selected="true"]')?.textContent).toContain('Switch window: Main')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(useConsoleStore.getState().activeSessionId).toBe('session-dev')
  })
})
