import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneNotifications } from './PaneNotifications'

const mocks = vi.hoisted(() => {
  const queryCache = new Map<string, any>()
  return {
    preferenceState: { agentNotificationsEnabled: true, agentNotificationDurationMs: 5000 },
    consoleState: { activeHostId: 'local', activeSessionId: 'local:other', activePaneId: 'local:%0', setActiveHost: vi.fn(), setActiveSession: vi.fn(), setActivePane: vi.fn() },
    queryCache,
    queryClient: {
      getQueryData: vi.fn((key: unknown[]) => queryCache.get(JSON.stringify(key))),
      setQueryData: vi.fn((key: unknown[], value: any) => queryCache.set(JSON.stringify(key), typeof value === 'function' ? value(queryCache.get(JSON.stringify(key))) : value)),
    },
    snapshotGet: vi.fn(),
    windowSelect: vi.fn(),
    paneSelect: vi.fn(),
  }
})
const { preferenceState, consoleState, queryCache, queryClient, snapshotGet, windowSelect, paneSelect } = mocks

vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => ({ preferences: mocks.preferenceState }) }))
vi.mock('@/hooks/useOptionalQueryClient', () => ({ useOptionalQueryClient: () => mocks.queryClient }))
vi.mock('@/stores/useConsoleStore', () => ({ useConsoleStore: Object.assign((selector: any) => selector(mocks.consoleState), { getState: () => mocks.consoleState }) }))
vi.mock('@/lib/api', () => ({ api: { snapshot: { get: mocks.snapshotGet }, windows: { select: mocks.windowSelect }, panes: { select: mocks.paneSelect } } }))
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (key: string, params?: Record<string, string>) => key === 'agent.notification.blocked' ? `${params?.agent} blocked in ${params?.session}` : key === 'agent.notification.done' ? `${params?.agent} finished in ${params?.session}` : key }) }))

function emitAgentStatus(status: 'blocked' | 'done', revision: number) {
  window.dispatchEvent(new CustomEvent('tmuxgo-agent-status', { detail: { hostId: 'local', sessionName: 'dev', pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: status, revision } } }))
}

describe('PaneNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    localStorage.setItem('tmuxgo-watched-panes', JSON.stringify(['local:%1']))
    preferenceState.agentNotificationsEnabled = true
    preferenceState.agentNotificationDurationMs = 5000
    queryCache.clear()
    snapshotGet.mockReset()
    windowSelect.mockReset()
    paneSelect.mockReset()
    windowSelect.mockResolvedValue({ ok: true })
    paneSelect.mockResolvedValue({ ok: true })
    consoleState.setActiveHost.mockReset()
    consoleState.setActiveSession.mockReset()
    consoleState.setActivePane.mockReset()
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
  it('filters notifications from panes that are not watched', () => {
    localStorage.setItem('tmuxgo-watched-panes', '[]')
    render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 5))
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toEqual([])
  })
  it('keeps notification history after the popup duration', () => {
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 6))
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-toggle-notifications')))
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toHaveLength(1)
  })
  it('uses a browser notification while the page is hidden', () => {
    const originalNotification = window.Notification
    const close = vi.fn()
    const browserNotification = vi.fn(function (this: any) { this.close = close }) as any
    browserNotification.permission = 'granted'
    Object.defineProperty(window, 'Notification', { configurable: true, value: browserNotification })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 7))
    expect(browserNotification).toHaveBeenCalledWith('notification.title', expect.objectContaining({ body: 'codex finished in dev' }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(window, 'Notification', { configurable: true, value: originalNotification })
  })
  it('clears visible notifications when they are disabled', () => {
    const { rerender } = render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 3))
    expect(screen.getByText('codex blocked in dev')).toBeInTheDocument()
    preferenceState.agentNotificationsEnabled = false
    rerender(<PaneNotifications />)
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
  })
  it('opens the target window and pane when a notification is clicked', async () => {
    vi.useRealTimers()
    snapshotGet.mockResolvedValueOnce({ activeWindowId: 'local:@1', activePaneId: 'local:%0', panes: [{ id: 'local:%1', windowId: 'local:@2', active: false }] }).mockResolvedValueOnce({ activeWindowId: 'local:@2', activePaneId: 'local:%1', panes: [{ id: 'local:%1', windowId: 'local:@2', active: true }] })
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 4))
    fireEvent.click(screen.getByText('codex finished in dev'))
    await waitFor(() => expect(consoleState.setActivePane).toHaveBeenCalledWith('local:%1'))
    expect(windowSelect).toHaveBeenCalledWith('local', 'session-local-dev', 'local:@2')
    expect(paneSelect).toHaveBeenCalledWith('local:%1')
    expect(snapshotGet).toHaveBeenCalledTimes(2)
    expect(consoleState.setActiveSession).toHaveBeenCalledWith('session-local-dev')
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['session-snapshot', 'local', 'session-local-dev'], expect.objectContaining({ activePaneId: 'local:%1' }))
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
  })
})
