import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneGrid } from './PaneGrid'
import { useConsoleStore } from '@/stores/useConsoleStore'

const sendMock = vi.hoisted(() => vi.fn(() => true))
const subscribeOutputMock = vi.hoisted(() => vi.fn(() => vi.fn()))

vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ sessionName, onReady }: { sessionName?: string; onReady?: () => void }) => <button onClick={onReady}>{sessionName || 'empty-session'}</button>,
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: sendMock, isConnected: false, isSocketReady: true, subscribeOutput: subscribeOutputMock }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { attachExclusive: true } }),
}))
vi.mock('@/hooks/useMobileKeyboard', () => ({
  isMobileDevice: () => false,
}))

describe('PaneGrid', () => {
  beforeEach(() => {
    sendMock.mockClear()
    subscribeOutputMock.mockClear()
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev1',
      activePaneId: null,
      connection: { status: 'attaching', latency: 0, lastPing: new Date().toISOString() },
      terminalPerf: { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' },
    } as any)
  })
  it('waits for the new terminal instance before attaching after session switch', async () => {
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', sessionName: 'dev1', cols: 120, rows: 36, exclusive: true }))
    const attachCallsBeforeSwitch = sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length
    act(() => {
      useConsoleStore.setState({ activeSessionId: 'session-dev2' })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'dev2' })).toBeInTheDocument())
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length).toBe(attachCallsBeforeSwitch)
    fireEvent.click(screen.getByRole('button', { name: 'dev2' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', sessionName: 'dev2', cols: 120, rows: 36, exclusive: true }))
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length).toBe(attachCallsBeforeSwitch + 1)
  })
})
