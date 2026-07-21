import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'

const selectWindow = vi.fn()
const snapshotGet = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  usePlugins: () => ({ data: { plugins: [] } }),
  useInvokePluginAction: () => ({ mutateAsync: vi.fn() }),
  useWindows: () => ({ data: [
    { id: 'local:@1', sessionId: 'session-dev', index: 0, name: 'Main', active: true },
    { id: 'local:@2', sessionId: 'session-dev', index: 1, name: 'Logs', active: false },
  ] }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: [{ id: 'session-dev', hostId: 'local', name: 'Dev', createdAt: '', lastActiveAt: '', windowCount: 2 }] }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => [
    { id: 'local:@1', sessionId: 'session-dev', index: 0, name: 'Main', active: true },
    { id: 'local:@2', sessionId: 'session-dev', index: 1, name: 'Logs', active: false },
  ], setWindows: vi.fn() }),
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
    render(
      React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} }))
    )
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.click(input)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(useConsoleStore.getState().activeSessionId).toBe('session-dev')
  })
  it('syncs active pane after switching window', async () => {
    const user = userEvent.setup()
    selectWindow.mockResolvedValue({ ok: true, windows: [
      { id: 'local:@1', sessionId: 'session-dev', index: 0, name: 'Main', active: false },
      { id: 'local:@2', sessionId: 'session-dev', index: 1, name: 'Logs', active: true },
    ] })
    snapshotGet.mockResolvedValue({ windows: [], panes: [{ id: 'local:%new', active: true }], activePaneId: 'local:%new' })
    render(
      React.createElement(I18nProvider, null, React.createElement(CommandPalette, { onClose: () => {} }))
    )
    const input = screen.getByPlaceholderText('Search hosts, sessions, windows...')
    await user.click(input)
    await user.type(input, 'logs')
    await user.keyboard('{Enter}')
    expect(selectWindow).toHaveBeenCalledWith('local', 'session-dev', 'local:@2')
    expect(snapshotGet).toHaveBeenCalledWith('local', 'session-dev')
    expect(useConsoleStore.getState().activePaneId).toBe('local:%new')
  })
})
