import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusBar } from './StatusBar'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key === 'status.connected' ? 'Connected' : key }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: any) => selector({
    activePaneId: 'local:%1',
    activeHostId: 'local',
    activeSessionId: 'session-local-dev',
    connection: { status: 'connected', latency: 0, lastPing: '' },
    terminalPerf: { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' },
  }),
}))
vi.mock('@/hooks/useSystemInfo', () => ({
  useSystemInfo: () => ({
    gpu: null,
    cpu: 42,
    mem: { used: 1536, total: 4096 },
    disks: [{ mount: '/', used: 10240, total: 20480 }, { mount: '/data', used: 20480, total: 40960 }],
    stream: {
      outputBytes: 0,
      outputChunks: 0,
      outputFlushes: 0,
      sanitizeCalls: 0,
      sanitizeChars: 0,
      attachRequests: 0,
      resizeRequests: 0,
      inputMessages: 0,
      backpressureSignals: 0,
      profileUpdates: 0,
      deferredFlushes: 0,
      socketBufferedBytes: 0,
      activeClients: 0,
      activeProfile: 'foreground',
      activeFlushInterval: 4,
      activeMaxChars: 65536,
    },
  }),
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local' }] }),
  useSessionSnapshot: () => ({ data: { panes: [{ id: 'local:%1', size: { cols: 120, rows: 30 } }] } }),
}))

describe('StatusBar', () => {
  it('groups context resources and connection into compact status sections', () => {
    render(<StatusBar />)
    const context = screen.getByLabelText('Workspace context')
    const resources = screen.getByLabelText('System resources')
    const connection = screen.getByLabelText('Connection status')
    expect(within(context).getByText('RW')).toBeInTheDocument()
    expect(within(context).getByText('Local')).toBeInTheDocument()
    expect(within(context).getByText('120×30')).toBeInTheDocument()
    expect(within(resources).getByText('CPU')).toBeInTheDocument()
    expect(within(resources).getByText('42%')).toBeInTheDocument()
    expect(within(connection).getByText('Connected')).toBeInTheDocument()
  })
  it('does not expose internal zero performance counters in the desktop status bar', () => {
    render(<StatusBar />)
    const resources = screen.getByLabelText('System resources')
    expect(within(resources).getByText('CPU')).toBeInTheDocument()
    expect(within(resources).getByText('42%')).toBeInTheDocument()
    expect(within(resources).getByText('MEM')).toBeInTheDocument()
    expect(within(resources).getByText('1.5/4.0G')).toBeInTheDocument()
    expect(within(resources).getByText('/')).toBeInTheDocument()
    expect(within(resources).getByText('10.0/20.0G')).toBeInTheDocument()
    expect(within(resources).getByText('/data')).toBeInTheDocument()
    expect(within(resources).getByText('20.0/40.0G')).toBeInTheDocument()
    expect(within(resources).queryByText('+1')).not.toBeInTheDocument()
    expect(screen.queryByText(/^WS /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^FL /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^BP /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^ATT /)).not.toBeInTheDocument()
  })
})
