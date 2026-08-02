import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { act } from 'react'
import { vi } from 'vitest'
import { Settings } from './Settings'
import { I18nProvider } from '@/i18n'
const pushToast=vi.fn()
const updatePreferences=vi.fn()
const restartRebuild=vi.fn()
const deleteHost=vi.fn()
const copy=vi.fn()
const shareApi=vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), revoke: vi.fn() }))
const restartStatusState={ data: { status: 'idle', startedAt: null, finishedAt: null, summaryLines: [], exitCode: null, errorMessage: null }, refetch: vi.fn() }
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: any) => selector({ pushToast, activeHostId: 'local', activeSessionId: 'session-local-dev' }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      language: 'en',
      terminalPadding: 8,
      uploadRateLimitKBps: 512,
      downloadRateLimitKBps: 512,
      fontSize: 14,
      fontFamily: 'monospace',
      cursorBlink: true,
      autoReconnect: true,
      reconnectInterval: 3000,
      theme: 'dark',
      sidebarPosition: 'left',
      showStatusBar: true,
      showQuickActions: true,
      agentNotificationsEnabled: true,
      agentNotificationDurationMs: 10000,
    },
    updatePreferences,
    resetPreferences: vi.fn(),
  }),
}))
vi.mock('@/hooks/useSessionContinuity', () => ({
  useSessionContinuity: () => ({
    sessionContinuity: { enabled: true, resumeOnReconnect: true, resumeOnNewDevice: false, resumePoints: [], maxResumePoints: 10, archive: { enabled: false, captureMode: 'none', maxBytesPerSession: 262144, retentionDays: 7 } },
    updateSessionContinuity: vi.fn(),
  }),
}))
vi.mock('@/hooks/useClipboard', () => ({
  useClipboard: () => ({ copy }),
}))
vi.mock('@/hooks/useAppVersion', () => ({
  useAppVersion: () => ({ data: { version: '0.1.0', buildId: '0.1.0-1900913' }, isLoading: false, error: null }),
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'edge', name: 'Edge', address: '10.0.0.8', user: 'deploy', port: 22, connectionMode: 'agent', agent: { version: '1.2.3', online: false, lastSeenAt: '2026-08-02T00:00:00.000Z', lastDisconnectedAt: '2026-08-02T00:01:00.000Z', disconnectReason: 'Heartbeat timed out', reconnectCount: 3 } }] }),
  useCreateHost: () => ({ mutateAsync: vi.fn() }),
  useDeleteHost: () => ({ mutateAsync: deleteHost }),
  useTestHost: () => ({ mutateAsync: vi.fn() }),
  useRestartRebuildStatus: () => restartStatusState,
  useRestartRebuild: () => ({ mutateAsync: restartRebuild, isPending: false }),
}))
vi.mock('@/lib/api', () => ({
  api: { shares: shareApi },
}))
describe('Settings restart rebuild', () => {
  beforeEach(() => {
    pushToast.mockReset()
    updatePreferences.mockReset()
    restartRebuild.mockReset()
    deleteHost.mockReset()
    copy.mockReset()
    shareApi.list.mockReset()
    shareApi.create.mockReset()
    shareApi.revoke.mockReset()
    copy.mockResolvedValue(true)
    shareApi.list.mockResolvedValue({ links: [] })
    deleteHost.mockResolvedValue({ success: true })
    restartStatusState.data = { status: 'idle', startedAt: null, finishedAt: null, summaryLines: [], exitCode: null, errorMessage: null }
    restartStatusState.refetch.mockReset()
    localStorage.setItem('tmuxgo-preferences', JSON.stringify({ language: 'en' }))
  })
  it('asks for confirmation before triggering restart rebuild', async () => {
    const user = userEvent.setup()
    restartRebuild.mockResolvedValue({ status: 'running', startedAt: '2026-06-08T00:00:00.000Z', finishedAt: null, summaryLines: ['Starting TmuxGo development servers...'], exitCode: null, errorMessage: null })
    render(React.createElement(I18nProvider, null, React.createElement(Settings, { onClose: vi.fn() })))
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'About' }))
    })
    await user.click(screen.getByRole('button', { name: 'Restart + Rebuild' }))
    expect(screen.getByText('Restart TmuxGo services?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(restartRebuild).toHaveBeenCalledTimes(1))
  })
  it('updates Agent notification settings', async () => {
    const user = userEvent.setup()
    render(React.createElement(I18nProvider, null, React.createElement(Settings, { onClose: vi.fn() })))
    await user.click(screen.getByRole('button', { name: 'Enable Agent notifications' }))
    expect(updatePreferences).toHaveBeenCalledWith({ agentNotificationsEnabled: false })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dismiss after' }), '30000')
    expect(updatePreferences).toHaveBeenCalledWith({ agentNotificationDurationMs: 30000 })
  })
  it('renders running status and recent summary lines', async () => {
    restartStatusState.data = {
      status: 'running',
      startedAt: '2026-06-08T00:00:00.000Z',
      finishedAt: null,
      summaryLines: ['Starting TmuxGo development servers...', 'Building systemd services...'],
      exitCode: null,
      errorMessage: null,
    }
    render(React.createElement(I18nProvider, null, React.createElement(Settings, { onClose: vi.fn() })))
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'About' }))
    })
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Starting TmuxGo development servers...')).toBeInTheDocument()
    expect(screen.getByText('Building systemd services...')).toBeInTheDocument()
  })
  it('asks for confirmation before removing a host', async () => {
    const user = userEvent.setup()
    render(React.createElement(I18nProvider, null, React.createElement(Settings, { onClose: vi.fn() })))
    await user.click(screen.getByRole('button', { name: 'Connection' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(deleteHost).not.toHaveBeenCalled()
    expect(screen.getByText('Remove host Edge and its saved connection details?')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!)
    await waitFor(() => expect(deleteHost).toHaveBeenCalledWith('edge'))
  })
  it('renders host connection and Agent diagnostics', async () => {
    const user = userEvent.setup()
    render(React.createElement(I18nProvider, null, React.createElement(Settings, { onClose: vi.fn() })))
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Connection' }))
    })
    expect(screen.getByText('Connection: Agent')).toBeInTheDocument()
    expect(screen.getByText(/Last heartbeat/)).toBeInTheDocument()
    expect(screen.getByText(/Reconnects 3/)).toBeInTheDocument()
    expect(screen.getByText(/Disconnect reason: Heartbeat timed out/)).toBeInTheDocument()
  })
  it('creates and copies a session-scoped share link', async () => {
    const user = userEvent.setup()
    shareApi.create.mockResolvedValue({ id: 'share-1', hostId: 'local', sessionName: 'dev', createdAt: '2026-08-02T00:00:00.000Z', expiresAt: '2026-08-02T01:00:00.000Z', revokedAt: null, token: 'share-token' })
    render(React.createElement(I18nProvider, null, React.createElement(Settings, { onClose: vi.fn() })))
    await user.click(screen.getByRole('button', { name: 'Security' }))
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(shareApi.create).toHaveBeenCalledWith('local', 'dev', 60))
    expect(copy).toHaveBeenCalledWith(`${window.location.origin}/share#token=share-token`)
  })
})
