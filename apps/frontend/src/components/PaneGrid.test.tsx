import { createTerminalLayout } from '@/lib/terminal-layout'
import { createTerminalResizeMask } from '@/lib/terminal-resize-mask'
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
const retryConnectionMock = vi.hoisted(() => vi.fn())
const windowsData = vi.hoisted(() => [] as any[])
const hostsMockData = vi.hoisted(() => ({ value: [{ id: 'local' }] as any[] | undefined }))
const orderedSessionsData = vi.hoisted(() => ({ value: [] as any[] }))
const terminalProps = vi.hoisted(() => ({
  current: null as null | {
    sessionName?: string
    onReady?: () => void
    onResize?: (cols: number, rows: number) => void
    onResizeActivity?: () => void
    layoutSyncPendingRef?: { current: (() => boolean) | undefined }
    peekFitSizeRef?: { current: (() => { cols: number; rows: number } | null) | undefined }
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
    onResizeActivity?: () => void
    layoutSyncPendingRef?: { current: (() => boolean) | undefined }
    peekFitSizeRef?: { current: (() => { cols: number; rows: number } | null) | undefined }
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
    retryConnection: retryConnectionMock,
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
  useHosts: () => ({ data: hostsMockData.value }),
  useWindows: () => ({ data: windowsData }),
  useSessionSnapshot: () => ({ data: null }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: orderedSessionsData.value }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => [], setWindows: vi.fn() }),
}))

const frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
const tick = (count = 1) => {
  for (let i = 0; i < count; i++) {
    const callbacks = [...frames.entries()]
    frames.clear()
    for (const [, cb] of callbacks) cb(0)
  }
}
// 真实 layout harness：RO→layout→PaneGrid 联动回归用。onResize 走 mock 由用例
// 自行桥接；onResizeActivity 直通 terminalProps（真实容器活动恒可达 PaneGrid）
function createHarness() {
  const container = document.createElement('div')
  container.innerHTML =
    '<div class="xterm"><div class="xterm-screen"><div class="xterm-rows"></div></div><div class="xterm-viewport"></div></div>'
  document.body.append(container)
  let width = 800
  let height = 480
  Object.defineProperties(container, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
  })
  const resizeCalls: Array<[number, number]> = []
  const terminal: any = {
    element: container.firstElementChild,
    cols: 80,
    rows: 24,
    options: { fontSize: 16, fontFamily: 'monospace' },
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: 10, height: 20 }, canvas: { width: 800, height: 480 } } },
        clear: vi.fn(),
      },
    },
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      resizeCalls.push([cols, rows])
    },
    refresh: vi.fn(),
    scrollToBottom: vi.fn(),
    clearTextureAtlas: vi.fn(),
    clearSelection: vi.fn(),
    buffer: { active: { baseY: 0, viewportY: 0 } },
  }
  const maskElement = document.createElement('div')
  const mask = createTerminalResizeMask({ mask: maskElement, getTerminal: () => terminal })
  const onResize = vi.fn()
  const revealMask = vi.fn((generation?: number) => mask.reveal(generation))
  const pendingRemoteResizeRef: { current: { cols: number; rows: number } | null } = { current: null }
  const layout = createTerminalLayout({
    container,
    isMobile: false,
    getTerminal: () => terminal,
    isDisposed: () => false,
    preferencesRef: { current: { fontSize: 16, fontFamily: 'monospace', cursorBlink: true, terminalPadding: 0 } },
    attachExclusiveRef: { current: true },
    lastSizeRef: { current: { cols: 80, rows: 24 } },
    sharedSessionSizeRef: { current: null },
    pendingRemoteResizeRef,
    onResizeRef: { current: onResize },
    onResizeActivityRef: { current: () => terminalProps.current?.onResizeActivity?.() },
    controlCarryRef: { current: '' },
    mask,
    revealMask,
    getTerminalPerf: () => ({
      attachLatency: 0,
      outputBytes: 0,
      outputEvents: 0,
      outputBacklog: 0,
      layoutFitCount: 0,
      lastOutputAt: '',
    }),
    updateTerminalPerf: vi.fn(),
    notifyReady: vi.fn(),
    requestServerRedraw: vi.fn(),
  })
  return {
    layout,
    container,
    terminal,
    mask,
    maskElement,
    resizeCalls,
    onResize,
    revealMask,
    pendingRemoteResizeRef,
    // 模拟服务端 resized/localOnly 确认到达（runtime handleResized 的尺寸匹配清零）
    ackResize(cols: number, rows: number) {
      const pending = pendingRemoteResizeRef.current
      if (pending && pending.cols === cols && pending.rows === rows) pendingRemoteResizeRef.current = null
    },
    setSize(nextWidth: number, nextHeight: number) {
      width = nextWidth
      height = nextHeight
    },
  }
}

describe('PaneGrid', () => {
  beforeEach(() => {
    sendMock.mockClear()
    subscribeOutputMock.mockClear()
    // jsdom 无焦点概念（hasFocus 恒 false），补 stub 让页面处于激活态
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    socketState.isConnected = false
    socketState.isSocketReady = true
    terminalProps.current = null
    hostsMockData.value = [{ id: 'local' }]
    orderedSessionsData.value = []
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
  it('keeps exclusive size on blur but attaches as passive (no height shrink)', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
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
        passive: true,
      }),
    )
  })
  it('re-attaches exclusive after the page regains focus', async () => {
    const hasFocus = vi.mocked(document.hasFocus)
    hasFocus.mockReturnValue(false)
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'attach', sessionName: 'dev1', exclusive: true, passive: true }),
      ),
    )
    sendMock.mockClear()
    hasFocus.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'attach', sessionName: 'dev1', exclusive: true }),
      ),
    )
    const lastAttach = sendMock.mock.calls.filter(([m]) => m?.type === 'attach').at(-1)?.[0]
    expect(lastAttach).not.toHaveProperty('passive')
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
  it('merges continuous drags into one trailing send of the final size', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    // 持续快速变化（40ms 一格 < 150ms 静止窗）：远端零发送
    for (let c = 121; c <= 130; c++) {
      act(() => terminalProps.current?.onResize?.(c, 40))
      act(() => vi.advanceTimersByTime(40))
    }
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
    // 停拖收敛：静止窗到期只发最终 130
    act(() => vi.advanceTimersByTime(160))
    const resizes = sendMock.mock.calls.filter(([m]) => m.type === 'resize')
    expect(resizes).toHaveLength(1)
    expect(resizes[0][0]).toMatchObject({ cols: 130, rows: 40 })
  })
  it('merges back-to-back drags and releases the queued size only after quiet + ACK', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    // 第一拖：121 静止后发出
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(160))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // 紧接第二拖 130/140：130 在途 ACK 未回，140 排队
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(160)) // 静止窗到但在途 → 不发
    act(() => terminalProps.current?.onResize?.(140, 40))
    act(() => vi.advanceTimersByTime(160)) // 140 静止窗也到
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // ACK 到 → 只补最终 140
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 140, rows: 40 })
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(2)
  })
  it('does not let an ACK pierce the still-open quiet window', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(160))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // 121 在途；新尺寸 130 静止窗还没到期时 ACK 到达：只释放在途，不得发送
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(40))
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // 静止窗到期后才发 130
    act(() => vi.advanceTimersByTime(120))
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
    act(() => vi.advanceTimersByTime(160))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(160))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 99, rows: 30 }))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // 正确的 121 ACK 到达后才补发最新 130（此时 130 静止窗已过）
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
    act(() => vi.advanceTimersByTime(160))
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
    act(() => vi.advanceTimersByTime(160))
    act(() => terminalProps.current?.onResize?.(130, 40))
    // 121 的 ACK 丢失：1200ms 兜底清在途；此时 130 静止窗已过 → 补发最新 130
    act(() => vi.advanceTimersByTime(1300))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 130, rows: 40 })
    // 迟到的 121 旧 ACK 不得再推进任何状态
    sendMock.mockClear()
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
  })
  it('does not resend the size the remote already has', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(160))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    sendMock.mockClear()
    // 拖走再拖回 121：最终尺寸与远端一致 → 零发送
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(300))
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
    act(() => vi.advanceTimersByTime(160))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(40))
    view.unmount()
    sendMock.mockClear()
    act(() => vi.advanceTimersByTime(1400))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
  })
  it('holds remote resize during continuous real container activity at 32ms RO cadence', () => {
    vi.useFakeTimers()
    frames.clear()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrameId++
      frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 80, rows: 24 }))
    sendMock.mockClear()
    const h = createHarness()
    h.onResize.mockImplementation((cols: number, rows: number) => terminalProps.current?.onResize?.(cols, rows))
    h.layout.primeContainerSize()
    // RO 每 32ms 一次真实容器变化（拖动中）：静止截止被活动顺延，
    // 节流 fit ~160ms 一发不得让远端在拖动途中发送
    for (let i = 0; i < 32; i++) {
      act(() => vi.advanceTimersByTime(32))
      h.setSize(810 + i * 10, 480)
      act(() => {
        h.layout.notifyObservedResize()
        tick()
      })
      const sent = sendMock.mock.calls.filter(([m]) => m.type === 'resize').at(-1)?.[0]
      if (sent) act(() => emitStreamEvent(STREAM_EVENT.resized, { ...sent, sessionName: 'dev1' }))
    }
    const midDrag = sendMock.mock.calls.filter(([m]) => m.type === 'resize')
    // 拖动收敛：停止观察后只发一次最终尺寸
    act(() => vi.advanceTimersByTime(200))
    act(() => tick(6))
    act(() => vi.advanceTimersByTime(200))
    const resizes = sendMock.mock.calls.filter(([m]) => m.type === 'resize')
    h.layout.dispose()
    h.container.remove()
    vi.unstubAllGlobals()
    expect(midDrag).toHaveLength(0)
    expect(resizes.length).toBeLessThanOrEqual(1)
  })
  it('emits localOnly settle when the deduped final size matches the acknowledged size', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(160))
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    const completed = vi.fn()
    const unsubscribe = subscribeStreamEvent(STREAM_EVENT.resized, completed)
    sendMock.mockClear()
    // A→B→A 已 ACK 路径：去重零发送但必须补 localOnly 释放终端 pending
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => vi.advanceTimersByTime(500))
    unsubscribe()
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ cols: 121, rows: 40, localOnly: true }))
  })
  it('waits for the final local fit to land before sending the settled size', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    // 本地 fit 在途时静止窗到期也不发中间尺寸；落地后才发最终尺寸
    let settling = true
    act(() => {
      if (terminalProps.current?.layoutSyncPendingRef)
        terminalProps.current.layoutSyncPendingRef.current = () => settling
    })
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(300))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
    settling = false
    act(() => vi.advanceTimersByTime(20))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 130, rows: 40 })
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
  })
  it('suppresses all remote sends during pointer drag and commits once after pointerup settle', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
    // move 阶段：尺寸持续变化 + 时间远超静止窗，远端仍零发送
    for (let c = 121; c <= 128; c++) {
      act(() => terminalProps.current?.onResize?.(c, 40))
      act(() => vi.advanceTimersByTime(60))
    }
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
    // pointerup → 50ms settle 内只发最终尺寸一次
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
    act(() => vi.advanceTimersByTime(50))
    const resizes = sendMock.mock.calls.filter(([m]) => m.type === 'resize')
    expect(resizes).toHaveLength(1)
    expect(resizes[0][0]).toMatchObject({ cols: 128, rows: 40 })
  })
  it('merges five rapid pointer drags into a single final remote resize', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    // 5 次快速 down/up（间隔 < settle 窗）：整个 burst 只提交最终一次
    for (let i = 0; i < 5; i++) {
      act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
      act(() => terminalProps.current?.onResize?.(121 + i * 4, 40))
      act(() => vi.advanceTimersByTime(30))
      act(() => terminalProps.current?.onResize?.(122 + i * 4, 40))
      act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
      act(() => vi.advanceTimersByTime(30)) // up→下一次 down 间隔 30ms < 50ms settle
    }
    act(() => vi.advanceTimersByTime(200))
    const resizes = sendMock.mock.calls.filter(([m]) => m.type === 'resize')
    expect(resizes).toHaveLength(1)
    expect(resizes[0][0]).toMatchObject({ cols: 138, rows: 40 })
  })
  it('commits independent pointer drags separated beyond the settle window', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
    act(() => vi.advanceTimersByTime(60))
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 130, rows: 40 }))
    // 长间隔后的第二次独立拖动应各自提交
    act(() => vi.advanceTimersByTime(500))
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
    act(() => terminalProps.current?.onResize?.(140, 44))
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
    act(() => vi.advanceTimersByTime(60))
    const resizes = sendMock.mock.calls.filter(([m]) => m.type === 'resize')
    expect(resizes).toHaveLength(2)
    expect(resizes[1][0]).toMatchObject({ cols: 140, rows: 44 })
  })
  it('does not let an ACK pierce an active pointer burst', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    // 第一次拖拽提交 121（在途 ACK 未回）
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
    act(() => terminalProps.current?.onResize?.(121, 40))
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
    act(() => vi.advanceTimersByTime(60))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // 第二次拖拽期间 ACK 到达：只释放在途，不得穿透 burst 发 130
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => emitStreamEvent(STREAM_EVENT.resized, { sessionName: 'dev1', hostId: 'local', cols: 121, rows: 40 }))
    act(() => vi.advanceTimersByTime(200))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(1)
    // pointerup settle 后补发最终尺寸
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
    act(() => vi.advanceTimersByTime(60))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 130, rows: 40 })
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(2)
  })
  it('keeps sending final size when local fit is still settling after pointerup', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    let settling = true
    act(() => {
      if (terminalProps.current?.layoutSyncPendingRef)
        terminalProps.current.layoutSyncPendingRef.current = () => settling
    })
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
    act(() => terminalProps.current?.onResize?.(126, 40))
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
    // settle 到期但本地 fit 未落地：继续等，不发中间尺寸
    act(() => vi.advanceTimersByTime(60))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
    settling = false
    act(() => vi.advanceTimersByTime(40))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 126, rows: 40 })
  })
  it('anchors the quiet window to the last container activity, not to the final fit', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    // t=0 真实容器活动；RO→稳定帧→fit 链 ~50ms 后 onResize 才到——
    // 静止截止仍锚在 t=80（活动+quiet），不得因 fit 晚到而重开成 t=130
    act(() => terminalProps.current?.onResizeActivity?.())
    act(() => vi.advanceTimersByTime(50))
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(35)) // t=85
    const resizes = sendMock.mock.calls.filter(([m]) => m.type === 'resize')
    expect(resizes).toHaveLength(1)
    expect(resizes[0][0]).toMatchObject({ cols: 130, rows: 40 })
  })
  it('keeps a full quiet window for onResize without recent container activity', () => {
    vi.useFakeTimers()
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    act(() => emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', hostId: 'local', cols: 120, rows: 36 }))
    sendMock.mockClear()
    // 无活动源的独立 onResize（初始 fit/字体变化）：仍走完整 now+quiet
    act(() => terminalProps.current?.onResize?.(130, 40))
    act(() => vi.advanceTimersByTime(70))
    expect(sendMock.mock.calls.filter(([m]) => m.type === 'resize')).toHaveLength(0)
    act(() => vi.advanceTimersByTime(30))
    expect(sendMock).toHaveBeenLastCalledWith({ type: 'resize', hostId: 'local', cols: 130, rows: 40 })
  })
})

describe('multi-device exclusive ownership', () => {
  beforeEach(() => {
    sendMock.mockClear()
    subscribeOutputMock.mockClear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    socketState.isConnected = false
    socketState.isSocketReady = true
    terminalProps.current = null
    hostsMockData.value = [{ id: 'local' }]
    orderedSessionsData.value = []
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
    sendMock.mockImplementation(() => true)
  })
  it('demotes to shared+passive after exclusive-revoked and reclaims on refocus', async () => {
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'attach', sessionName: 'dev1', exclusive: true }),
      ),
    )
    sendMock.mockClear()
    act(() => {
      emitStreamEvent(STREAM_EVENT.exclusiveRevoked, { hostId: 'local', sessionName: 'dev1' })
    })
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'attach', sessionName: 'dev1', exclusive: false, passive: true }),
      ),
    )
    // 仍保持旁观，不自动抢回（防双端 pageActive 互抢）
    sendMock.mockClear()
    await new Promise((r) => setTimeout(r, 30))
    expect(sendMock).not.toHaveBeenCalled()

    // 失焦（已旁观，无需再 attach）→ 聚焦：重新 claim exclusive（电脑回来继续用）
    vi.mocked(document.hasFocus).mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    vi.mocked(document.hasFocus).mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    sendMock.mockClear()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'attach', sessionName: 'dev1', exclusive: true }),
      ),
    )
    const last = sendMock.mock.calls.filter(([m]) => m?.type === 'attach').at(-1)?.[0]
    expect(last).not.toHaveProperty('passive')
  })

  it('single focused page keeps exclusive attach (single-instance baseline)', async () => {
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'attach', exclusive: true, sessionName: 'dev1' }),
      ),
    )
  })

  it('shows spectating state with a takeover entry that re-claims via existing arbitration', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'attach' })))
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36 })
    })
    expect(document.querySelector('[data-ownership]')?.getAttribute('data-ownership')).toBe('owned')
    act(() => {
      emitStreamEvent(STREAM_EVENT.exclusiveRevoked, { hostId: 'local', sessionName: 'dev1' })
    })
    await waitFor(() =>
      expect(document.querySelector('[data-ownership]')?.getAttribute('data-ownership')).toBe('spectating'),
    )
    sendMock.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'grid.control.takeover' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'attach', sessionName: 'dev1', exclusive: true }),
      ),
    )
  })

  it('collapses the status bar while owned and expands it for actionable states', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'attach' })))
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36 })
    })
    const ownedBar = document.querySelector('[data-ownership]') as HTMLElement
    expect(ownedBar.getAttribute('data-ownership')).toBe('owned')
    // 正常就绪态整条收起（不再常驻遮挡终端）；状态标记仍在 DOM 可查
    expect(ownedBar.className).toContain('hidden')
    // 320px 窄屏约束（类名层面）：限宽常驻 + 展开态可换行，按钮不被裁掉
    expect(ownedBar.className).toContain('max-w-')
    act(() => {
      emitStreamEvent(STREAM_EVENT.exclusiveRevoked, { hostId: 'local', sessionName: 'dev1' })
    })
    await waitFor(() =>
      expect(document.querySelector('[data-ownership]')?.getAttribute('data-ownership')).toBe('spectating'),
    )
    const spectatingBar = document.querySelector('[data-ownership]') as HTMLElement
    expect(spectatingBar.className).toContain('flex')
    expect(spectatingBar.className).toContain('flex-wrap')
    expect(spectatingBar.className).not.toContain('hidden')
  })

  it('keeps takeover pending until a real attach succeeds and restores retry on revoke', async () => {
    socketState.isConnected = true
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'attach' })))
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36 })
      emitStreamEvent(STREAM_EVENT.exclusiveRevoked, { hostId: 'local', sessionName: 'dev1' })
    })
    await waitFor(() =>
      expect(document.querySelector('[data-ownership]')?.getAttribute('data-ownership')).toBe('spectating'),
    )
    sendMock.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'grid.control.takeover' }))
    // 点击≠接管：进入请求中态，入口消失
    expect(screen.getByTestId('takeover-pending')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'grid.control.takeover' })).toBeNull()
    // 被拒回落旁观 → 恢复可重试入口
    act(() => {
      emitStreamEvent(STREAM_EVENT.exclusiveRevoked, { hostId: 'local', sessionName: 'dev1' })
    })
    expect(screen.queryByTestId('takeover-pending')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'grid.control.takeover' }))
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'attach', sessionName: 'dev1' })),
    )
    expect(screen.getByTestId('takeover-pending')).toBeTruthy()
    // 完成条件=真实 attached 事件
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { hostId: 'local', sessionName: 'dev1', cols: 120, rows: 36 })
    })
    expect(screen.queryByTestId('takeover-pending')).toBeNull()
  })

  it('read-only share shows readonly status and never a takeover entry', () => {
    render(
      <PaneGrid
        sessionId="session-dev1"
        shared
        socket={{
          send: sendMock,
          isConnected: true,
          isSocketReady: true,
          subscribeOutput: subscribeOutputMock,
        }}
      />,
    )
    expect(document.querySelector('[data-ownership]')?.getAttribute('data-ownership')).toBe('readonly')
    expect(screen.queryByRole('button', { name: 'grid.control.takeover' })).toBeNull()
  })

  it('shows pending input chip while disconnected and clear prevents any resend', async () => {
    socketState.isConnected = true
    const view = render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'attach' })))
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
    })
    // 断线后键入 → 入队并显示待发提示 + 动作入口
    act(() => {
      socketState.isConnected = false
    })
    view.rerender(<PaneGrid />)
    act(() => {
      terminalProps.current?.onInput?.('ls\n')
    })
    expect(screen.getByText(/grid\.input\.pending/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'grid.input.clear' }))
    expect(screen.queryByText(/grid\.input\.pending/)).toBeNull()
    // 清空后给轻量反馈，且不回显待发内容
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('grid.input.cleared')
    // 恢复连接后已清空的输入绝不补发
    sendMock.mockClear()
    act(() => {
      socketState.isConnected = true
    })
    view.rerender(<PaneGrid />)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sendMock.mock.calls.filter(([message]) => message?.type === 'input')).toHaveLength(0)
  })

  it('empty state offers next-step entry for each scenario', () => {
    useConsoleStore.setState({ activeSessionId: '' } as any)
    // 有主机无会话 → 新建会话（SessionPanel 监听 tmuxgo-open-create-session）
    const listener = vi.fn()
    window.addEventListener('tmuxgo-open-create-session', listener)
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'grid.createSession' }))
    expect(listener).toHaveBeenCalled()
    expect(useConsoleStore.getState().sessionPanelExpanded).toBe(true)
    window.removeEventListener('tmuxgo-open-create-session', listener)
  })
  it('empty state offers select-recent when sessions exist', () => {
    orderedSessionsData.value = [{ id: 'session-dev1' }]
    useConsoleStore.setState({ activeSessionId: '' } as any)
    render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'grid.selectRecent' }))
    expect(useConsoleStore.getState().activeSessionId).toBe('session-dev1')
  })
  it('empty state offers add-host when no hosts are configured', () => {
    hostsMockData.value = []
    useConsoleStore.setState({ activeSessionId: '' } as any)
    render(<PaneGrid />)
    expect(screen.getByRole('button', { name: 'grid.addHost' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'grid.createSession' })).toBeNull()
  })

  it('auto-flushes queued input after reconnect and offers a retry entry', async () => {
    socketState.isConnected = true
    const view = render(<PaneGrid />)
    fireEvent.click(screen.getByRole('button', { name: 'dev1' }))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'attach' })))
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
    })
    act(() => {
      socketState.isConnected = false
    })
    view.rerender(<PaneGrid />)
    act(() => {
      terminalProps.current?.onInput?.('pwd\n')
    })
    expect(screen.getByText(/grid\.input\.pending/)).toBeTruthy()
    // 链路中断时提供「立即重试」入口
    fireEvent.click(screen.getByRole('button', { name: 'grid.input.retry' }))
    expect(retryConnectionMock).toHaveBeenCalled()
    // 恢复连接并重新附着成功：既有自动补发行为清空队列与提示
    sendMock.mockClear()
    act(() => {
      socketState.isConnected = true
    })
    view.rerender(<PaneGrid />)
    act(() => {
      emitStreamEvent(STREAM_EVENT.attached, { sessionName: 'dev1', cols: 120, rows: 36, hostId: 'local' })
    })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ type: 'input', data: 'pwd\n' }))
    expect(screen.queryByText(/grid\.input\.pending/)).toBeNull()
  })
})
