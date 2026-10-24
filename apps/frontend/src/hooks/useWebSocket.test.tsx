import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSocket } from './useWebSocket'
import { subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { STREAM_BINARY_TYPE_OUTPUT, STREAM_BINARY_VERSION } from '@/lib/stream-binary'
const updateConnectionMock = vi.fn()
const preferenceState = { autoReconnect: false, reconnectInterval: 1000 }
const authState = { enabled: false }
const getWebSocketUrlMock = vi.fn()
const socketInstances: MockWebSocket[] = []
class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  onopen: ((event?: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  bufferedAmount = 0
  constructor(_url: string) {
    socketInstances.push(this)
  }
  send(_data: string) {}
  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
  error() {
    this.onerror?.()
  }
  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  binaryMessage(buffer: ArrayBuffer) {
    this.onmessage?.({ data: buffer } as unknown as { data: string })
  }
}
// 非 compact 帧头：TG + version + type + hostLen + sessionLen + dataLen（全小端）
function binaryOutputFrame(hostId: string, sessionName: string, data: string) {
  const enc = new TextEncoder()
  const host = enc.encode(hostId)
  const session = enc.encode(sessionName)
  const payload = enc.encode(data)
  const buffer = new ArrayBuffer(12 + host.length + session.length + payload.length)
  const view = new DataView(buffer)
  view.setUint8(0, 0x54)
  view.setUint8(1, 0x47)
  view.setUint8(2, STREAM_BINARY_VERSION)
  view.setUint8(3, STREAM_BINARY_TYPE_OUTPUT)
  view.setUint16(4, host.length, true)
  view.setUint16(6, session.length, true)
  view.setUint32(8, payload.length, true)
  const bytes = new Uint8Array(buffer)
  bytes.set(host, 12)
  bytes.set(session, 12 + host.length)
  bytes.set(payload, 12 + host.length + session.length)
  return buffer
}

vi.mock('./usePreferences', () => ({
  usePreferences: () => ({ preferences: preferenceState }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (
    selector: (state: { connection: { status: string }; updateConnection: typeof updateConnectionMock }) => unknown,
  ) => selector({ connection: { status: 'disconnected' }, updateConnection: updateConnectionMock }),
}))
vi.mock('@/lib/runtime-endpoints', () => ({
  getWebSocketBase: () => 'ws://localhost:3000/api/stream',
}))
vi.mock('@/lib/auth', () => ({
  isAuthEnabled: () => authState.enabled,
  getWebSocketUrl: () => getWebSocketUrlMock(),
}))
vi.mock('@/lib/mobile-diagnostics', () => ({
  recordMobileDiagnostic: vi.fn(),
}))
describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    updateConnectionMock.mockReset()
    preferenceState.autoReconnect = false
    preferenceState.reconnectInterval = 1000
    authState.enabled = false
    getWebSocketUrlMock.mockReset()
    socketInstances.length = 0
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('tracks the mirror sequence from JSON output frames and invalidates it otherwise', () => {
    const { result, unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
    })
    expect(result.current.getLastMirrorSeq()).toBeNull()
    act(() => {
      socketInstances[0].message({ type: 'output', data: 'a', hostId: 'local', sessionName: 'dev', mirrorSeq: 7 })
    })
    expect(result.current.getLastMirrorSeq()).toBe(7)
    act(() => {
      socketInstances[0].message({ type: 'output', data: 'b', hostId: 'local', sessionName: 'dev', mirrorSeq: 9 })
    })
    expect(result.current.getLastMirrorSeq()).toBe(9)
    // 快照是新的基准：旧序号不再可比，必须作废，否则重连会报一个错基准
    act(() => {
      socketInstances[0].message({ type: 'output_resync', data: 'snap', hostId: 'local', sessionName: 'dev' })
    })
    expect(result.current.getLastMirrorSeq()).toBeNull()
    unmount()
  })

  it('drops the mirror sequence when a binary output frame arrives', () => {
    const { result, unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
    })
    act(() => {
      socketInstances[0].message({ type: 'output', data: 'a', hostId: 'local', sessionName: 'dev', mirrorSeq: 7 })
    })
    expect(result.current.getLastMirrorSeq()).toBe(7)
    // 二进制输出帧协议上不带 mirrorSeq：此后序号不可信，继续上报会让服务端补发
    // 已经渲染过的字节（重复内容）。宁可回整快照
    act(() => {
      socketInstances[0].binaryMessage(binaryOutputFrame('local', 'dev', 'x'))
    })
    expect(result.current.getLastMirrorSeq()).toBeNull()
    unmount()
  })

  it('dispatches terminal attach errors and leaves attaching state', async () => {
    const tmuxErrorListener = vi.fn()
    const unsubscribeError = subscribeStreamEvent(STREAM_EVENT.error, tmuxErrorListener)
    const { unmount } = renderHook(() => useWebSocket())
    expect(socketInstances.length).toBe(1)
    act(() => {
      socketInstances[0].open()
    })
    expect(updateConnectionMock).toHaveBeenCalledWith({ status: 'attaching', latency: 0 })
    act(() => {
      socketInstances[0].message({ type: 'error', message: 'Session not found', hostId: 'local', sessionName: 'dev' })
    })
    expect(tmuxErrorListener).toHaveBeenCalledTimes(1)
    expect(updateConnectionMock).toHaveBeenCalledWith({ status: 'disconnected' })
    expect(tmuxErrorListener.mock.calls[0]?.[0]).toMatchObject({
      message: 'Session not found',
      hostId: 'local',
      sessionName: 'dev',
    })
    unsubscribeError()
    unmount()
  })
  it('treats an unknown agent frame type as a capability mismatch instead of a disconnect', () => {
    const feedUnsupported = vi.fn()
    const tmuxErrorListener = vi.fn()
    const unsubscribeFeed = subscribeStreamEvent(STREAM_EVENT.agentFeedUnsupported, feedUnsupported)
    const unsubscribeError = subscribeStreamEvent(STREAM_EVENT.error, tmuxErrorListener)
    const { unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
    })
    updateConnectionMock.mockClear()
    act(() => {
      socketInstances[0].message({ type: 'error', message: 'Unknown message type: agent_subscribe' })
    })
    expect(feedUnsupported).toHaveBeenCalledTimes(1)
    // 老网关只会回这一句：不能当成终端错误，更不能把连接打成断线触发重连
    expect(tmuxErrorListener).not.toHaveBeenCalled()
    expect(updateConnectionMock).not.toHaveBeenCalledWith({ status: 'disconnected' })
    unsubscribeFeed()
    unsubscribeError()
    unmount()
  })
  it('routes terminal output to its host and session listeners only', () => {
    const listener = vi.fn()
    const otherSessionListener = vi.fn()
    const otherHostListener = vi.fn()
    const { result, unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
    })
    const unsubscribe = result.current.subscribeOutput('local', 'dev', listener)
    const unsubscribeOtherSession = result.current.subscribeOutput('local', 'other', otherSessionListener)
    const unsubscribeOtherHost = result.current.subscribeOutput('remote', 'dev', otherHostListener)
    act(() => {
      socketInstances[0].message({ type: 'output_resync', data: 'snapshot', hostId: 'local', sessionName: 'dev' })
    })
    expect(listener).toHaveBeenCalledWith({ data: 'snapshot', hostId: 'local', sessionName: 'dev', resync: true })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(otherSessionListener).not.toHaveBeenCalled()
    expect(otherHostListener).not.toHaveBeenCalled()
    unsubscribe()
    unsubscribeOtherSession()
    unsubscribeOtherHost()
    unmount()
  })
  it('dispatches completed terminal resize events', () => {
    const listener = vi.fn()
    const unsubscribeResized = subscribeStreamEvent(STREAM_EVENT.resized, listener)
    const { unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
      socketInstances[0].message({ type: 'resized', hostId: 'local', sessionName: 'dev', cols: 120, rows: 36 })
    })
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ hostId: 'local', sessionName: 'dev', cols: 120, rows: 36 })
    unsubscribeResized()
    unmount()
  })
  it('dispatches agent status events', () => {
    const listener = vi.fn()
    const unsubscribeStatus = subscribeStreamEvent(STREAM_EVENT.agentStatus, listener)
    const { unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
      socketInstances[0].message({
        type: 'agent_status_changed',
        hostId: 'local',
        sessionName: 'dev',
        pane: { paneId: 'local:%1', agent: 'codex', agentStatus: 'blocked', revision: 2 },
      })
    })
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      hostId: 'local',
      sessionName: 'dev',
      pane: { agentStatus: 'blocked' },
    })
    unsubscribeStatus()
    unmount()
  })
  it('dispatches the agent monitor event types', () => {
    const listeners = { snapshot: vi.fn(), removed: vi.fn(), notification: vi.fn(), error: vi.fn() }
    const unsubs = [
      subscribeStreamEvent(STREAM_EVENT.agentStatusSnapshot, listeners.snapshot),
      subscribeStreamEvent(STREAM_EVENT.agentStatusRemoved, listeners.removed),
      subscribeStreamEvent(STREAM_EVENT.agentNotification, listeners.notification),
      subscribeStreamEvent(STREAM_EVENT.agentMonitorError, listeners.error),
    ]
    const { unmount } = renderHook(() => useWebSocket())
    const snapshot = { type: 'agent_status_snapshot', initial: true, hostId: 'local', revision: 3, agents: [] }
    const removed = {
      type: 'agent_status_removed',
      initial: false,
      hostId: 'local',
      sessionName: 'dev',
      paneId: 'local:%1',
      reason: 'pane_exited',
    }
    const notification = {
      type: 'agent_notification',
      initial: false,
      hostId: 'local',
      sessionName: 'dev',
      eventId: 'local:local:%1:failed:4',
      pane: { paneId: 'local:%1', agent: 'codex', agentStatus: 'unknown', phase: 'failed', revision: 4 },
    }
    const monitorError = {
      type: 'agent_monitor_error',
      initial: false,
      hostId: 'remote',
      message: 'Agent monitor scan failed',
      retrying: true,
    }
    act(() => {
      socketInstances[0].open()
      socketInstances[0].message(snapshot)
      socketInstances[0].message(removed)
      socketInstances[0].message(notification)
      socketInstances[0].message(monitorError)
    })
    expect(listeners.snapshot.mock.calls[0]?.[0]).toEqual(snapshot)
    expect(listeners.removed.mock.calls[0]?.[0]).toEqual(removed)
    expect(listeners.notification.mock.calls[0]?.[0]).toEqual(notification)
    expect(listeners.error.mock.calls[0]?.[0]).toEqual(monitorError)
    for (const unsub of unsubs) unsub()
    unmount()
  })
  it('keeps a live socket after returning from the background', () => {
    const { unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1201)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.OPEN)
    expect(socketInstances).toHaveLength(1)
    unmount()
  })
  it('reconnects when the probe ping times out after returning from the background', () => {
    preferenceState.autoReconnect = true
    const { unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].open()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1201)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1500)
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('does not replace a socket that is still connecting after returning from the background', () => {
    const { unmount } = renderHook(() => useWebSocket())
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1201)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CONNECTING)
    expect(socketInstances).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(8001)
      window.dispatchEvent(new Event('focus'))
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('keeps a pending authenticated connection after returning from the background', async () => {
    authState.enabled = true
    let resolveFreshTicket: (url: string) => void = () => {}
    getWebSocketUrlMock
      .mockImplementationOnce(() => new Promise<string>(() => {}))
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFreshTicket = resolve
          }),
      )
    const { unmount } = renderHook(() => useWebSocket())
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(1)
    expect(socketInstances).toHaveLength(0)
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1201)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(1)
    expect(socketInstances).toHaveLength(0)
    await act(async () => {
      vi.advanceTimersByTime(8001)
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveFreshTicket('ws://localhost:3000/api/stream?ticket=fresh')
      await Promise.resolve()
    })
    expect(socketInstances).toHaveLength(1)
    unmount()
  })
  it('does not interrupt a connecting socket on ordinary focus', () => {
    const { unmount } = renderHook(() => useWebSocket())
    expect(socketInstances).toHaveLength(1)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(socketInstances).toHaveLength(1)
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CONNECTING)
    unmount()
  })
  it('replaces a connecting socket only after it has been stale for 8s', () => {
    const { unmount } = renderHook(() => useWebSocket())
    expect(socketInstances).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(8001)
      window.dispatchEvent(new Event('focus'))
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('does not restart a pending authenticated connection on ordinary focus', async () => {
    authState.enabled = true
    getWebSocketUrlMock.mockImplementation(() => new Promise<string>(() => {}))
    const { unmount } = renderHook(() => useWebSocket())
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(1)
    expect(socketInstances).toHaveLength(0)
    unmount()
  })
  it('reconnects after a socket error without waiting for close', () => {
    preferenceState.autoReconnect = true
    const { unmount } = renderHook(() => useWebSocket())
    act(() => {
      socketInstances[0].error()
      vi.advanceTimersByTime(400)
    })
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('retries when a socket handshake never completes', () => {
    preferenceState.autoReconnect = true
    const { unmount } = renderHook(() => useWebSocket())
    expect(socketInstances).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
})
