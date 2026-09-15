import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatusBar } from './StatusBar'

const sessionsQueryMock = vi.hoisted(() => ({ dataUpdatedAt: Date.now(), isError: false }))
const consoleStateMock = vi.hoisted(() => ({
  activePaneId: 'local:%1',
  activeHostId: 'local',
  activeSessionId: 'session-local-dev',
  connection: {
    status: 'connected' as 'connected' | 'attaching' | 'reconnecting' | 'disconnected',
    latency: 0,
    lastPing: '',
  },
  terminalPerf: {
    attachLatency: 0,
    outputBytes: 0,
    outputEvents: 0,
    outputBacklog: 0,
    layoutFitCount: 0,
    lastOutputAt: '',
  },
}))
const useSystemInfoMock = vi.hoisted(() =>
  vi.fn(() => ({
    hostId: 'local',
    gpu: null,
    cpu: 42,
    mem: { used: 1536, total: 4096 },
    disks: [
      { mount: '/', used: 10240, total: 20480 },
      { mount: '/data', used: 20480, total: 40960 },
    ],
    dependencies: { tmux: true, git: true, python: true, rg: true, sshpass: false },
    stream: {},
  })),
)

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const translations: Record<string, string> = {
        'status.connected': 'Connected',
        'status.sessionSync': 'SYNC',
        'status.sessionSyncStatus': 'Session sync status',
        'status.syncPending': '...',
        'status.syncAge': '{seconds}s',
        'status.syncFreshTitle': 'Sessions last synced {age} ago',
        'status.syncDelayedTitle': 'Session sync delayed; last success {age} ago',
        'status.syncFailedTitle': 'Session sync failed; last success {age} ago',
        'status.syncPendingTitle': 'Waiting for the first session sync',
        'status.failed': 'failed',
        'status.host': 'HOST',
        'status.hostScanStatus': 'Host scan status',
        'status.scanFailed': 'scan failed',
        'status.scanFailedTitle': 'Remote host agent scan failed; retrying',
      }
      let text = translations[key] || key
      Object.entries(params || {}).forEach(([name, value]) => {
        text = text.replace(`{${name}}`, String(value))
      })
      return text
    },
  }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: any) => selector(consoleStateMock),
}))
vi.mock('@/hooks/useSystemInfo', () => ({
  useSystemInfo: useSystemInfoMock,
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local' }] }),
  useSessions: () => sessionsQueryMock,
  useSessionSnapshot: () => ({ data: { panes: [{ id: 'local:%1', size: { cols: 120, rows: 30 } }] } }),
}))

describe('StatusBar', () => {
  beforeEach(() => {
    consoleStateMock.connection.status = 'connected'
    sessionsQueryMock.dataUpdatedAt = Date.now()
    sessionsQueryMock.isError = false
  })
  afterEach(() => vi.useRealTimers())
  it('groups context resources and connection into compact status sections', () => {
    render(<StatusBar />)
    const context = screen.getByLabelText('Workspace context')
    const resources = screen.getByLabelText('System resources')
    const connection = screen.getByLabelText('Connection status')
    expect(within(context).getByText('Local')).toBeInTheDocument()
    expect(within(context).getByText('120×30')).toBeInTheDocument()
    expect(within(resources).getByText('CPU')).toBeInTheDocument()
    expect(within(resources).getByText('42%')).toBeInTheDocument()
    expect(within(connection).getByText('Connected')).toBeInTheDocument()
    expect(useSystemInfoMock).toHaveBeenCalledWith('local', 2000)
  })
  it('shows the last successful session sync age and marks it delayed after 15 seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'))
    sessionsQueryMock.dataUpdatedAt = Date.now() - 14000
    render(<StatusBar />)
    const sync = screen.getByLabelText('Session sync status')
    expect(within(sync).getByText('14s')).toBeInTheDocument()
    expect(sync.firstElementChild).toHaveClass('text-accent-2')
    act(() => vi.advanceTimersByTime(1000))
    expect(within(sync).getByText('15s')).toBeInTheDocument()
    expect(sync.firstElementChild).toHaveClass('text-warn')
  })
  it('shows a failed session refresh without losing its last successful age', () => {
    sessionsQueryMock.dataUpdatedAt = Date.now() - 4000
    sessionsQueryMock.isError = true
    render(<StatusBar />)
    const sync = screen.getByLabelText('Session sync status')
    expect(within(sync).getByText('failed 4s')).toBeInTheDocument()
    expect(sync.firstElementChild).toHaveClass('text-danger')
  })
  it('distinguishes a host scan failure from the gateway connection and clears it after retries recover', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'))
    sessionsQueryMock.dataUpdatedAt = Date.now()
    render(<StatusBar />)
    act(() => emitStreamEvent(STREAM_EVENT.agentMonitorError, { hostId: 'local' }))
    expect(within(screen.getByLabelText('Host scan status')).getByText('scan failed')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Connection status')).getByText('Connected')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByLabelText('Host scan status')).not.toBeInTheDocument()
  })
  it('shows the three largest disks and reveals all storage on hover', () => {
    useSystemInfoMock.mockImplementation(() => ({
      hostId: 'local',
      gpu: null,
      cpu: 42,
      mem: { used: 1536, total: 4096 },
      disks: [
        { mount: '/', used: 10240, total: 20480 },
        { mount: '/data', used: 20480, total: 40960 },
        { mount: '/home', used: 30720, total: 40960 },
        { mount: '/tmp', used: 5120, total: 20480 },
      ],
      dependencies: { tmux: true, git: true, python: true, rg: true, sshpass: false },
      stream: {},
    }))
    render(<StatusBar />)
    const resources = screen.getByLabelText('System resources')
    expect(within(resources).getByText('/home')).toBeInTheDocument()
    expect(within(resources).getByText('/data')).toBeInTheDocument()
    expect(within(resources).getByText('/')).toBeInTheDocument()
    expect(within(resources).queryByText('/tmp')).not.toBeInTheDocument()
    const storageTrigger = within(resources).getByRole('button', { name: 'Show all storage' })
    fireEvent.mouseEnter(storageTrigger.parentElement!)
    expect(within(resources).getByRole('list', { name: 'All storage' })).toBeInTheDocument()
    expect(within(resources).getByText('/tmp')).toBeInTheDocument()
    fireEvent.mouseLeave(storageTrigger.parentElement!)
    expect(within(resources).queryByRole('list', { name: 'All storage' })).not.toBeInTheDocument()
    useSystemInfoMock.mockImplementation(() => ({
      hostId: 'local',
      gpu: null,
      cpu: 42,
      mem: { used: 1536, total: 4096 },
      disks: [
        { mount: '/', used: 10240, total: 20480 },
        { mount: '/data', used: 20480, total: 40960 },
      ],
      dependencies: { tmux: true, git: true, python: true, rg: true, sshpass: false },
      stream: {},
    }))
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
    expect(within(resources).getByText('DEP')).toBeInTheDocument()
    expect(within(resources).getByText('1')).toBeInTheDocument()
    expect(within(resources).queryByText('+1')).not.toBeInTheDocument()
    expect(screen.queryByText(/^WS /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^FL /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^BP /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^ATT /)).not.toBeInTheDocument()
  })
})
