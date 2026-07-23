import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SystemHealthPanel } from './SystemHealthPanel'
import { I18nProvider } from '@/i18n'

const systemInfo = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { system: { info: systemInfo } } }))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: any) => selector({ activeHostId: 'local' }),
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'edge', name: 'Edge' }] }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { language: 'en' } }),
}))

describe('SystemHealthPanel', () => {
  it('renders resource and stream cards from system info', async () => {
    systemInfo.mockReset()
    systemInfo.mockResolvedValue({
      hostId: 'local',
      gpu: { used: 1024, total: 8192 },
      cpu: 42,
      mem: { used: 2048, total: 8192 },
      disks: [{ mount: '/', used: 10240, total: 20480 }],
      dependencies: { tmux: true, git: true, python: true, rg: false, sshpass: true },
      stream: {
        outputBytes: 4096,
        outputChunks: 3,
        outputFlushes: 2,
        outputResyncRequests: 1,
        outputResyncCompleted: 1,
        droppedOutputChars: 0,
        sanitizeCalls: 0,
        sanitizeChars: 0,
        attachRequests: 4,
        snapshotRequests: 1,
        resizeRequests: 2,
        inputMessages: 8,
        backpressureSignals: 0,
        profileUpdates: 1,
        deferredFlushes: 0,
        socketBufferedBytes: 128,
        activeClients: 2,
        activeProfile: 'foreground',
        activeFlushInterval: 8,
        activeMaxChars: 65536,
      },
    })
    render(React.createElement(I18nProvider, null, React.createElement(SystemHealthPanel)))
    await waitFor(() => expect(screen.getByText('42%')).toBeInTheDocument())
    expect(screen.getByText('Host resources')).toBeInTheDocument()
    expect(screen.getByText('Stream health')).toBeInTheDocument()
    expect(screen.getByText('/')).toBeInTheDocument()
    expect(screen.getByText('rg')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh now' }))
    await waitFor(() => expect(systemInfo.mock.calls.length).toBeGreaterThanOrEqual(2))
  })
})
