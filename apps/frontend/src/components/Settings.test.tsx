import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { act } from 'react'
import { vi } from 'vitest'
import { Settings } from './Settings'
import { I18nProvider } from '@/i18n'
const pushToast=vi.fn()
const restartRebuild=vi.fn()
const deleteHost=vi.fn()
const restartStatusState={ data: { status: 'idle', startedAt: null, finishedAt: null, summaryLines: [], exitCode: null, errorMessage: null }, refetch: vi.fn() }
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: any) => selector({ pushToast }),
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
    },
    updatePreferences: vi.fn(),
    resetPreferences: vi.fn(),
  }),
}))
vi.mock('@/hooks/useSessionContinuity', () => ({
  useSessionContinuity: () => ({
    sessionContinuity: { enabled: true, resumeOnReconnect: true, resumeOnNewDevice: false, resumePoints: [], maxResumePoints: 10 },
    updateSessionContinuity: vi.fn(),
  }),
}))
vi.mock('@/hooks/useClipboard', () => ({
  useClipboard: () => ({ copy: vi.fn(async () => true) }),
}))
vi.mock('@/hooks/useAppVersion', () => ({
  useAppVersion: () => ({ data: { version: '0.1.0', buildId: '0.1.0-1900913' }, isLoading: false, error: null }),
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'edge', name: 'Edge', address: '10.0.0.8', user: 'deploy', port: 22 }] }),
  useCreateHost: () => ({ mutateAsync: vi.fn() }),
  useDeleteHost: () => ({ mutateAsync: deleteHost }),
  useTestHost: () => ({ mutateAsync: vi.fn() }),
  useRestartRebuildStatus: () => restartStatusState,
  useRestartRebuild: () => ({ mutateAsync: restartRebuild, isPending: false }),
}))
describe('Settings restart rebuild', () => {
  beforeEach(() => {
    pushToast.mockReset()
    restartRebuild.mockReset()
    deleteHost.mockReset()
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
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(deleteHost).not.toHaveBeenCalled()
    expect(screen.getByText('Remove host Edge and its saved connection details?')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!)
    await waitFor(() => expect(deleteHost).toHaveBeenCalledWith('edge'))
  })
})
