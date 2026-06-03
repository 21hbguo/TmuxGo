import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneGrid } from './PaneGrid'
import { useConsoleStore } from '@/stores/useConsoleStore'

const sendMock = vi.hoisted(() => vi.fn((_message: any) => true))
const subscribeOutputMock = vi.hoisted(() => vi.fn(() => vi.fn()))
const socketState = vi.hoisted(() => ({ isConnected: false, isSocketReady: true }))
const terminalProps = vi.hoisted(() => ({ current: null as null | { sessionName?: string; onReady?: () => void; onResize?: (cols: number, rows: number) => void; onInput?: (data: string) => void } }))

vi.mock('./TerminalPane', () => ({
  TerminalPane: (props: { sessionName?: string; onReady?: () => void; onResize?: (cols: number, rows: number) => void; onInput?: (data: string) => void }) => {
    terminalProps.current = props
    return <button onClick={props.onReady}>{props.sessionName || 'empty-session'}</button>
  },
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: sendMock, isConnected: socketState.isConnected, isSocketReady: socketState.isSocketReady, subscribeOutput: subscribeOutputMock }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { attachExclusive: true } }),
}))
vi.mock('@/hooks/useSessionContinuity', () => ({
  useSessionContinuity: () => ({
    sessionContinuity: { enabled: false },
    upsertResumePoint: vi.fn(),
  }),
}))
vi.mock('@/hooks/useMobileKeyboard', () => ({
  isMobileDevice: () => false,
}))
vi.mock('@/hooks/useApi', () => ({
  useWindows: () => ({ data: [] }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => [], setWindows: vi.fn() }),
}))

describe('PaneGrid', () => {
  beforeEach(() => {
    sendMock.mockClear()
    subscribeOutputMock.mockClear()
    socketState.isConnected = false
    socketState.isSocketReady = true
    terminalProps.current = null
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
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36, exclusive: true }))
    const attachCallsBeforeSwitch = sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length
    act(() => {
      useConsoleStore.setState({ activeSessionId: 'session-dev2' })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'dev2' })).toBeInTheDocument())
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length).toBe(attachCallsBeforeSwitch)
    fireEvent.click(screen.getByRole('button', { name: 'dev2' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', hostId: 'local', sessionName: 'dev2', cols: 120, rows: 36, exclusive: true }))
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length).toBe(attachCallsBeforeSwitch + 1)
  })
  it('sends terminal resize immediately after attach', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36, exclusive: true }))
    act(() => {
      window.dispatchEvent(new CustomEvent('tmux-attached', { detail: { sessionName: 'dev1', cols: 120, rows: 36 } }))
    })
    sendMock.mockClear()
    act(() => {
      terminalProps.current?.onResize?.(121, 36)
    })
    expect(sendMock).toHaveBeenCalledWith({ type: 'resize', hostId: 'local', cols: 121, rows: 36 })
  })
  it('re-attaches and flushes queued input after detach', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36, exclusive: true }))
    act(() => {
      window.dispatchEvent(new CustomEvent('tmux-attached', { detail: { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' } }))
    })
    sendMock.mockClear()
    act(() => {
      window.dispatchEvent(new CustomEvent('tmux-detached', { detail: { sessionName: 'dev1', hostId: 'local' } }))
    })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36, exclusive: true }))
    sendMock.mockClear()
    act(() => {
      terminalProps.current?.onInput?.('pwd')
    })
    expect(sendMock).not.toHaveBeenCalledWith({ type: 'input', data: 'pwd' })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'attach', hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36, exclusive: true }))
    sendMock.mockClear()
    act(() => {
      window.dispatchEvent(new CustomEvent('tmux-attached', { detail: { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' } }))
    })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'input', data: 'pwd' }))
  })
})
