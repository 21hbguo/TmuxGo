import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { emitStreamEvent, subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneGrid } from './PaneGrid'
import { useConsoleStore } from '@/stores/useConsoleStore'

const sendMock = vi.hoisted(() => vi.fn((_message: any) => true))
const subscribeOutputMock = vi.hoisted(() =>
  vi.fn((_hostId: string, _sessionName: string, _listener: unknown) => vi.fn()),
)
const socketState = vi.hoisted(() => ({ isConnected: false, isSocketReady: true }))
const windowsData = vi.hoisted(() => [] as any[])
const terminalProps = vi.hoisted(() => ({
  current: null as null | {
    sessionName?: string
    onReady?: () => void
    onResize?: (cols: number, rows: number) => void
    onInput?: (data: string) => void
  },
}))
const continuityState = vi.hoisted(() => ({
  value: {
    enabled: false,
    archive: { enabled: false, captureMode: 'none', maxBytesPerSession: 262144, retentionDays: 7 },
    resumePoints: [] as any[],
  },
  upsertResumePoint: vi.fn(),
}))

vi.mock('./TerminalPane', () => ({
  TerminalPane: (props: {
    sessionName?: string
    onReady?: () => void
    onResize?: (cols: number, rows: number) => void
    onInput?: (data: string) => void
  }) => {
    terminalProps.current = props
    return <button onClick={props.onReady}>{props.sessionName || 'empty-session'}</button>
  },
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    send: sendMock,
    isConnected: socketState.isConnected,
    isSocketReady: socketState.isSocketReady,
    subscribeOutput: subscribeOutputMock,
  }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { attachExclusive: true } }),
}))
vi.mock('@/hooks/useSessionContinuity', () => ({
  useSessionContinuity: () => ({
    sessionContinuity: continuityState.value,
    upsertResumePoint: continuityState.upsertResumePoint,
  }),
}))
vi.mock('@/hooks/useMobileKeyboard', () => ({
  isMobileDevice: () => false,
}))
vi.mock('@/hooks/useApi', () => ({
  useWindows: () => ({ data: windowsData }),
  useSessionSnapshot: () => ({ data: null }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: [] }),
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
    continuityState.value = {
      enabled: false,
      archive: { enabled: false, captureMode: 'none', maxBytesPerSession: 262144, retentionDays: 7 },
      resumePoints: [],
    }
    continuityState.upsertResumePoint.mockReset()
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev1',
      activePaneId: null,
      connection: { status: 'attaching', latency: 0, lastPing: new Date().toISOString() },
      terminalPerf: {
        attachLatency: 0,
        outputBytes: 0,
        outputEvents: 0,
        outputBacklog: 0,
        layoutFitCount: 0,
        lastOutputAt: '',
      },
    } as any)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('waits for the new terminal instance before attaching after session switch', async () => {
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    expect(subscribeOutputMock).toHaveBeenCalledWith('local', 'dev1', expect.any(Function))
    const attachCallsBeforeSwitch = sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length
    act(() => {
      useConsoleStore.setState({ activeSessionId: 'session-dev2' })
    })
    expect(screen.getByRole('button', { name: 'dev2' })).toBeInTheDocument()
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev2',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach').length).toBe(
      attachCallsBeforeSwitch + 1,
    )
  })
  it('uses a controlled session without changing the global session', async () => {
    render(<PaneGrid sessionId="session-dev2" />)
    fireEvent.click(screen.getByRole('button', { name: 'dev2' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev2',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    expect(useConsoleStore.getState().activeSessionId).toBe('session-dev1')
  })
  it('switches to next session immediately on switch', async () => {
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    act(() => {
      useConsoleStore.setState({ activeSessionId: 'session-dev2' })
    })
    expect(screen.getByRole('button', { name: 'dev2' })).toBeInTheDocument()
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev2',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev2', cols: 120, rows: 36, hostId: 'local' })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'dev2' })).toBeInTheDocument())
  })
  it('sends a stabilized terminal resize immediately', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36 })
    })
    sendMock.mockClear()
    act(() => {
      terminalProps.current?.onResize?.(123, 36)
    })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'resize', hostId: 'local', cols: 123, rows: 36 }))
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'resize')).toHaveLength(1)
  })
  it('does not report normal input to the debug endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', fetchMock)
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
      terminalProps.current?.onInput?.('x'.repeat(769))
    })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'input', data: 'x'.repeat(769) }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not repeat resize after attach when tmux reports the same size', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    act(() => {
      terminalProps.current?.onResize?.(121, 40)
    })
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 121,
        rows: 40,
        exclusive: true,
      }),
    )
    sendMock.mockClear()
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 121, rows: 40, hostId: 'local' })
    })
    expect(sendMock).not.toHaveBeenCalledWith({ type: 'resize', hostId: 'local', cols: 121, rows: 40 })
  })
  it('completes a local-only resize after detach without sending it', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
    })
    sendMock.mockClear()
    const listener = vi.fn()
    const unsubscribe = subscribeStreamEvent(STREAM_EVENT.resized, listener)
    act(() => {
      emitStreamEvent(STREAM_EVENT.detached, { sessionName: 'dev1', hostId: 'local' })
      terminalProps.current?.onResize?.(124, 38)
    })
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'resize')).toHaveLength(0)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ sessionName: 'dev1', cols: 124, rows: 38, localOnly: true })
    unsubscribe()
  })
  it('re-attaches and flushes queued input after detach', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
    })
    sendMock.mockClear()
    act(() => {
      emitStreamEvent(STREAM_EVENT.detached, { sessionName: 'dev1', hostId: 'local' })
    })
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach')).toHaveLength(0)
    await waitFor(
      () =>
        expect(sendMock).toHaveBeenCalledWith({
          type: 'attach',
          hostId: 'local',
          sessionName: 'dev1',
          cols: 120,
          rows: 36,
          exclusive: true,
        }),
      { timeout: 1600 },
    )
    sendMock.mockClear()
    act(() => {
      terminalProps.current?.onInput?.('pwd')
    })
    expect(sendMock).not.toHaveBeenCalledWith({ type: 'input', data: 'pwd' })
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach')).toHaveLength(0)
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
    })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'input', data: 'pwd' }))
  })
  it('does not repeat attach while input is queued during attachment', async () => {
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'attach',
        hostId: 'local',
        sessionName: 'dev1',
        cols: 120,
        rows: 36,
        exclusive: true,
      }),
    )
    act(() => {
      for (let i = 0; i < 30; i += 1) terminalProps.current?.onInput?.(`input-${i}`)
    })
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'attach')).toHaveLength(1)
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'input')).toHaveLength(0)
  })
  it('does not flush again when only resume points change', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    const archive = { enabled: false, captureMode: 'none', maxBytesPerSession: 262144, retentionDays: 7 }
    continuityState.value = { enabled: true, archive, resumePoints: [] }
    const view = render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
      vi.advanceTimersByTime(100)
    })
    expect(continuityState.upsertResumePoint).toHaveBeenCalled()
    continuityState.upsertResumePoint.mockClear()
    continuityState.value = { enabled: true, archive, resumePoints: [{ sessionId: 'session-dev1' }] }
    view.rerender(<PaneGrid />)
    expect(continuityState.upsertResumePoint).not.toHaveBeenCalled()
  })
  it('stops attach retry loop and shows the previous session when attach fails', async () => {
    vi.useFakeTimers()
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    expect(sendMock).toHaveBeenCalledWith({
      type: 'attach',
      hostId: 'local',
      sessionName: 'dev1',
      cols: 120,
      rows: 36,
      exclusive: true,
    })
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
    })
    expect(useConsoleStore.getState().connection.status).toBe('connected')
    sendMock.mockClear()
    act(() => {
      useConsoleStore.setState({ activeSessionId: 'session-dev2' })
    })
    expect(sendMock).toHaveBeenCalledWith({
      type: 'attach',
      hostId: 'local',
      sessionName: 'dev2',
      cols: 120,
      rows: 36,
      exclusive: true,
    })
    act(() => {
      emitStreamEvent(STREAM_EVENT.error, { hostId: 'local', sessionName: 'dev2', message: 'Session not found' })
    })
    expect(useConsoleStore.getState().activeSessionId).toBe('session-dev1')
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('Session not found')
    expect(screen.getByRole('button', { name: 'dev1' })).toBeInTheDocument()
    sendMock.mockClear()
    act(() => {
      vi.advanceTimersByTime(7000)
    })
    expect(sendMock).not.toHaveBeenCalledWith({
      type: 'attach',
      hostId: 'local',
      sessionName: 'dev2',
      cols: 120,
      rows: 36,
      exclusive: true,
    })
  })
  it('releases the queued latest size only after a matching ACK', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(40))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(40))
    // 在途限 1：121 已发，130 排队等 ACK
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 130, rows: 40 })
  })
  it('rejects a wrong-size stale ACK without releasing the in-flight resize', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(40))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(40))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 99, rows: 30 }))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // 正确的 121 ACK 到达后才补发最新 130
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 130, rows: 40 })
  })
  it('ignores a duplicate ACK with nothing in flight', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(40))
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
  })
  it('rejects a late old ACK that arrives after the stale timeout flushed the queue', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(40))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(40))
    // 121 的 ACK 丢失：1200ms 兜底清在途并补发最新 130
    act(() => vi.advanceTimersByTime(1200))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 130, rows: 40 })
    // 迟到的 121 旧 ACK 不得再推进任何状态
    sendMock.mockClear()
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
  })
  it('clears the stale ACK timer and queued size on unmount', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    const view = render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(40))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(40))
    view.unmount()
    sendMock.mockClear()
    act(() => vi.advanceTimersByTime(1300))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
  })
})
