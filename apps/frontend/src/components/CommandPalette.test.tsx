import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { CommandPalette } from './CommandPalette'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'

describe('CommandPalette', () => {
  beforeEach(() => {
    localStorage.setItem('tmuxgo-preferences', JSON.stringify({ language: 'en' }))
    useConsoleStore.setState({
      hosts: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }],
      sessions: [{ id: 'session-dev', hostId: 'local', name: 'Dev', createdAt: '', lastActiveAt: '', windowCount: 1 }],
      windows: [],
      panes: [],
      activeHostId: null,
      activeSessionId: null,
      activePaneId: null,
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
})
