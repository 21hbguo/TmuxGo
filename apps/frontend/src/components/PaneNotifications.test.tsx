import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneNotifications, WatchButton } from './PaneNotifications'

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
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (key: string, params?: Record<string, string>) => { const messages: Record<string, string> = { 'agent.notification.blocked': `${params?.agent} blocked in ${params?.session}`, 'agent.notification.done': `${params?.agent} finished in ${params?.session}`, 'agent.notification.permission': `${params?.agent} permission required in ${params?.session}`, 'agent.notification.question': `${params?.agent} needs input in ${params?.session}`, 'agent.notification.failed': `${params?.agent} failed in ${params?.session}`, 'agent.notification.ended': `${params?.agent} ended in ${params?.session}`, 'agent.notification.disconnected': `${params?.agent} disconnected in ${params?.session}` }; return messages[key] || key } }) }))

function emitAgentStatus(status: 'blocked' | 'done', revision: number) {
  window.dispatchEvent(new CustomEvent('tmuxgo-agent-status', { detail: { hostId: 'local', sessionName: 'dev', pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: status, revision } } }))
}

describe('PaneNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
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
  it('does not show an empty notification popup', () => {
    render(<PaneNotifications />)
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-toggle-notifications')))
    expect(screen.queryByText('notification.empty')).not.toBeInTheDocument()
  })
  it('allows the notification bubble to be dragged and saves its position', () => {
    localStorage.setItem('tmuxgo-notification-bubble-position', JSON.stringify({ x: 40, y: 60 }))
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 10))
    const bubble = screen.getByRole('button', { name: 'notification.title' })
    fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 70 })
    fireEvent.pointerMove(bubble, { pointerId: 1, pointerType: 'touch', clientX: 110, clientY: 130 })
    fireEvent.pointerUp(bubble, { pointerId: 1, pointerType: 'touch', clientX: 110, clientY: 130 })
    expect(bubble).toHaveStyle({ left: '100px', top: '120px' })
    expect(JSON.parse(localStorage.getItem('tmuxgo-notification-bubble-position') || 'null')).toEqual({ x: 100, y: 120 })
  })
  it('filters notifications from muted panes', () => {
    localStorage.setItem('tmuxgo-muted-pane-notifications', JSON.stringify(['local:%1']))
    render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 5))
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toEqual([])
  })
  it('restores an initial completed snapshot without notifying', () => {
    render(<PaneNotifications />)
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-agent-status', { detail: { hostId: 'local', sessionName: 'dev', initial: true, pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'done', revision: 8 } } })))
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toEqual([])
  })
  it('notifies from an explicit agent notification event', () => {
    render(<PaneNotifications />)
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-agent-notification', { detail: { type: 'agent_notification', hostId: 'local', sessionName: 'dev', eventId: 'local:local:%1:completed:9', pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'idle', phase: 'idle', lastEvent: 'completed', revision: 9 } } })))
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toHaveLength(1)
  })
  it('deduplicates explicit notifications by event id', () => {
    render(<PaneNotifications />)
    const detail = { type: 'agent_notification', hostId: 'local', sessionName: 'dev', eventId: 'local:local:%1:failed:10', pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'unknown', phase: 'failed', lastEvent: 'failed', revision: 10 } }
    act(() => {
      window.dispatchEvent(new CustomEvent('tmuxgo-agent-notification', { detail }))
      window.dispatchEvent(new CustomEvent('tmuxgo-agent-notification', { detail }))
    })
    expect(screen.getAllByText('codex failed in dev')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toHaveLength(1)
  })
  it('clears agent metadata but keeps the terminal pane when it is removed', () => {
    queryCache.set(JSON.stringify(['session-snapshot', 'local', 'session-local-dev']), { panes: [{ id: 'local:%1', windowId: 'local:@1', title: 'codex', agent: 'codex', agentStatus: 'working', phase: 'working', revision: 3 }] })
    render(<PaneNotifications />)
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-agent-status-removed', { detail: { type: 'agent_status_removed', hostId: 'local', sessionName: 'dev', paneId: 'local:%1', reason: 'pane_exited' } })))
    expect(queryClient.getQueryData(['session-snapshot', 'local', 'session-local-dev'])).toEqual({ panes: [{ id: 'local:%1', windowId: 'local:@1', title: 'codex' }] })
  })
  it('does not show a duplicate notification after reconnecting', () => {
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 9))
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-agent-status', { detail: { hostId: 'local', sessionName: 'dev', initial: true, pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'done', revision: 9 } } })))
    expect(screen.getAllByText('codex finished in dev')).toHaveLength(1)
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
  it('watches panes by default and allows muting them', () => {
    render(<WatchButton paneId="local:%1" />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
    expect(JSON.parse(localStorage.getItem('tmuxgo-muted-pane-notifications') || '[]')).toEqual(['local:%1'])
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
