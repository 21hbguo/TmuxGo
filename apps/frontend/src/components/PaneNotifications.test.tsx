import { act, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneNotifications } from './PaneNotifications'

const preferenceState = { agentNotificationsEnabled: true, agentNotificationDurationMs: 5000 }
const consoleState = { activeHostId: 'local', activeSessionId: 'local:other', activePaneId: 'local:%0', setActiveHost: vi.fn(), setActiveSession: vi.fn(), setActivePane: vi.fn() }

vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => ({ preferences: preferenceState }) }))
vi.mock('@/hooks/useOptionalQueryClient', () => ({ useOptionalQueryClient: () => null }))
vi.mock('@/stores/useConsoleStore', () => ({ useConsoleStore: Object.assign((selector: any) => selector(consoleState), { getState: () => consoleState }) }))
vi.mock('@/lib/api', () => ({ api: { panes: { select: vi.fn(async () => {}) } } }))
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (key: string, params?: Record<string, string>) => key === 'agent.notification.blocked' ? `${params?.agent} blocked in ${params?.session}` : key === 'agent.notification.done' ? `${params?.agent} finished in ${params?.session}` : key }) }))

function emitAgentStatus(status: 'blocked' | 'done', revision: number) {
  window.dispatchEvent(new CustomEvent('tmuxgo-agent-status', { detail: { hostId: 'local', sessionName: 'dev', pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: status, revision } } }))
}

describe('PaneNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    preferenceState.agentNotificationsEnabled = true
    preferenceState.agentNotificationDurationMs = 5000
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('dismisses notifications after the configured duration', () => {
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 1))
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4999))
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
  })
  it('does not add notifications when they are disabled', () => {
    preferenceState.agentNotificationsEnabled = false
    render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 2))
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
  })
  it('clears visible notifications when they are disabled', () => {
    const { rerender } = render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 3))
    expect(screen.getByText('codex blocked in dev')).toBeInTheDocument()
    preferenceState.agentNotificationsEnabled = false
    rerender(<PaneNotifications />)
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
  })
})
