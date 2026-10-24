import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SystemHealthPanel, remoteMetricsUnavailable } from './SystemHealthPanel'
import { I18nProvider } from '@/i18n'

const systemInfo = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { system: { info: systemInfo } } }))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: (state: { activeHostId: string }) => unknown) => selector({ activeHostId: 'local' }),
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'edge', name: 'Edge' }] }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { language: 'en' } }),
}))

const streamFixture = {
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
}

// 远端无 python 时 gateway 走 shell fallback：cpu 0 / mem 0/0 / disks 空 / net 全 0
const noPythonRemoteInfo = {
  hostId: 'edge',
  gpu: null,
  cpu: 0,
  mem: { used: 0, total: 0 },
  disks: [],
  net: {
    sentBytes: 0,
    recvBytes: 0,
    daySentBytes: 0,
    dayRecvBytes: 0,
    last24hSentBytes: 0,
    last24hRecvBytes: 0,
    trackedMs: 0,
  },
  dependencies: { tmux: true, git: true, python: false, rg: true, sshpass: true },
  stream: streamFixture,
}

describe('remoteMetricsUnavailable', () => {
  it('only treats non-local hosts without python as unavailable', () => {
    expect(remoteMetricsUnavailable(noPythonRemoteInfo as never)).toBe(true)
    expect(remoteMetricsUnavailable({ ...noPythonRemoteInfo, dependencies: { python: true } } as never)).toBe(false)
    // local 的 python 只是「本机装没装」，采集走 /proc，不影响读数
    expect(remoteMetricsUnavailable({ ...noPythonRemoteInfo, hostId: 'local' } as never)).toBe(false)
    expect(remoteMetricsUnavailable(null)).toBe(false)
  })
})

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

  it('renders unavailable state instead of fake zeros when a remote host lacks python', async () => {
    systemInfo.mockReset()
    systemInfo.mockResolvedValue(noPythonRemoteInfo)
    render(React.createElement(I18nProvider, null, React.createElement(SystemHealthPanel)))
    await waitFor(() => expect(screen.getByText('Host resources')).toBeInTheDocument())
    // 仪表区降级文案（CPU/MEM/网速各处都出现），且绝不出现 0% 这种假读数
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText(/install it to collect these metrics/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('0%')).toBeNull()
    expect(screen.queryByText('0.0/0.0G')).toBeNull()
    // 依赖 chips 的红标保留
    expect(screen.getByText('Missing')).toBeInTheDocument()
  })

  it('keeps local hosts rendering numbers even when dependencies.python is false', async () => {
    systemInfo.mockReset()
    systemInfo.mockResolvedValue({
      ...noPythonRemoteInfo,
      hostId: 'local',
      cpu: 17,
      mem: { used: 1024, total: 4096 },
      disks: [{ mount: '/', used: 1024, total: 4096 }],
    })
    render(React.createElement(I18nProvider, null, React.createElement(SystemHealthPanel)))
    await waitFor(() => expect(screen.getByText('17%')).toBeInTheDocument())
    expect(screen.queryByText('Unavailable')).toBeNull()
  })
})
