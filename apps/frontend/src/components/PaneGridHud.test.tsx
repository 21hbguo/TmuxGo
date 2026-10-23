import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneGrid } from './PaneGrid'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { Host, Pane, Session, Window } from '@/types'

// 滑动切换后方位 HUD 的集成断言：只钉 PaneGrid 的数据装配（文案/计时由 SwitchHud.test.tsx 负责）
type MockWindow = Partial<Window> & Pick<Window, 'id'>
type MockPane = Partial<Pane> & Pick<Pane, 'id'>
type MockSnapshot = {
  windows: MockWindow[]
  panes: MockPane[]
  activeWindowId: string | null
  activePaneId: string | null
}

const sendMock = vi.hoisted(() => vi.fn((_message: Record<string, unknown> & { type?: string }) => true))
const subscribeOutputMock = vi.hoisted(() => vi.fn((_hostId: string, _name: string, _listener: unknown) => vi.fn()))
const socketState = vi.hoisted(() => ({ isConnected: false, isSocketReady: true }))
const windowsData = vi.hoisted(() => [] as Array<Partial<Window> & Pick<Window, 'id'>>)
const hostsMockData = vi.hoisted(() => ({ value: [{ id: 'local' }] as Array<Pick<Host, 'id'>> | undefined }))
const orderedSessionsData = vi.hoisted(() => ({ value: [] as Array<Pick<Session, 'id'>> }))
const snapshotMockData = vi.hoisted(() => ({ value: null as MockSnapshot | null }))
const mobileMock = vi.hoisted(() => ({ value: false }))
const terminalProps = vi.hoisted(() => ({
  current: null as null | {
    sessionName?: string
    onReady?: () => void
    onInput?: (data: string) => void
    onSwipeLeft?: () => void
    onSwipeRight?: () => void
  },
}))

vi.mock('./TerminalPane', () => ({
  TerminalPane: (props: {
    sessionName?: string
    onReady?: () => void
    onInput?: (data: string) => void
    onSwipeLeft?: () => void
    onSwipeRight?: () => void
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
    retryConnection: vi.fn(),
  }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { attachExclusive: true } }),
}))
vi.mock('@/hooks/useSessionContinuity', () => ({
  useSessionContinuity: () => ({
    sessionContinuity: {
      enabled: false,
      archive: { enabled: false, captureMode: 'none', maxBytesPerSession: 262144, retentionDays: 7 },
      resumePoints: [],
    },
    upsertResumePoint: vi.fn(),
  }),
}))
// 移动端开关：HUD 只在 isMobile 为真时渲染
vi.mock('@/hooks/useMobileKeyboard', () => ({
  isMobileDevice: () => mobileMock.value,
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: hostsMockData.value }),
  useWindows: () => ({ data: windowsData }),
  useSessionSnapshot: () => ({ data: snapshotMockData.value }),
  // HUD 用例不关心同步输入：给空组，保持既有渲染路径不变
  useSyncPanes: () => ({ data: { panes: [], max: 16 } }),
  useSetSyncPanes: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: orderedSessionsData.value }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => [], setWindows: vi.fn() }),
}))
vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')
  return {
    useTranslation: () => ({
      language: 'zh',
      t: (key: string, params?: Record<string, string | number>) => {
        let text = (zh as Record<string, string>)[key] ?? key
        for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{${k}}`, String(v))
        return text
      },
    }),
  }
})

describe('PaneGrid switch HUD', () => {
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
    snapshotMockData.value = null
    windowsData.length = 0
    mobileMock.value = false
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev1',
      activePaneId: null,
      connection: { status: 'attaching', latency: 0, lastPing: new Date().toISOString() },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('flashes a switch HUD on mobile swipes with window position and neighbours', async () => {
    mobileMock.value = true
    const selectSpy = vi.spyOn(api.windows, 'select').mockResolvedValue({ ok: true, windows: [] })
    windowsData.push(
      { id: 'local:@1', sessionId: 'session-dev1', active: true, name: 'dev' },
      { id: 'local:@2', sessionId: 'session-dev1', active: false, name: 'ops' },
      { id: 'local:@3', sessionId: 'session-dev1', active: false, name: 'logs' },
    )
    render(<PaneGrid />)
    await waitFor(() => expect(terminalProps.current?.onSwipeLeft).toBeTruthy())
    await act(async () => {
      terminalProps.current!.onSwipeLeft!()
    })
    expect(selectSpy).toHaveBeenCalledWith('local', 'session-dev1', 'local:@2')
    // 落点 = 第 2 屏 ops；邻居按落点算：左 dev、右 logs
    const position = screen.getByTestId('switch-hud-position').textContent || ''
    expect(position).toContain('窗口 2/3')
    expect(position).toContain('ops')
    expect(screen.getByTestId('switch-hud-prev').textContent).toBe('← dev')
    expect(screen.getByTestId('switch-hud-next').textContent).toBe('logs →')
    // 段条随窗口总数变化：3 个窗口 = 3 段
    expect(screen.getByTestId('switch-hud-window-bar').children).toHaveLength(3)
    // 非 zoom 态不带 pane 行
    expect(screen.queryByTestId('switch-hud-pane')).toBeNull()
    // 非交互覆盖层：不吃终端手势
    expect(screen.getByTestId('switch-hud').className).toContain('pointer-events-none')
  })

  it('shows the pane position in the HUD when swiping inside a zoomed window', async () => {
    mobileMock.value = true
    const selectSpy = vi.spyOn(api.panes, 'select').mockResolvedValue({ ok: true })
    windowsData.push({ id: 'local:@1', sessionId: 'session-dev1', active: true, zoomed: true, name: 'dev' })
    snapshotMockData.value = {
      windows: [{ id: 'local:@1', zoomed: true }],
      panes: [
        { id: 'local:%1', windowId: 'local:@1', index: 0, title: 'left' },
        { id: 'local:%2', windowId: 'local:@1', index: 1, title: 'mid' },
        { id: 'local:%3', windowId: 'local:@1', index: 2, title: 'right' },
      ],
      activeWindowId: 'local:@1',
      activePaneId: 'local:%2',
    }
    render(<PaneGrid />)
    await waitFor(() => expect(terminalProps.current?.onSwipeLeft).toBeTruthy())
    await act(async () => {
      terminalProps.current!.onSwipeLeft!()
    })
    expect(selectSpy).toHaveBeenCalledWith('local:%3', { keepZoom: true })
    expect(screen.getByTestId('switch-hud-pane').textContent).toBe('面板 3/3')
    // 落点 right(3/3)：左侧邻居 mid，右侧循环回 left（与 switchPane 的回绕语义一致）
    expect(screen.getByTestId('switch-hud-prev').textContent).toBe('← mid')
    expect(screen.getByTestId('switch-hud-next').textContent).toBe('left →')
    expect(screen.getByTestId('switch-hud-position').textContent).toContain('窗口 1/1')
  })

  it('renders no HUD on desktop swipes', async () => {
    const selectSpy = vi.spyOn(api.windows, 'select').mockResolvedValue({ ok: true, windows: [] })
    windowsData.push(
      { id: 'local:@1', sessionId: 'session-dev1', active: true, name: 'dev' },
      { id: 'local:@2', sessionId: 'session-dev1', active: false, name: 'ops' },
    )
    render(<PaneGrid />)
    await waitFor(() => expect(terminalProps.current?.onSwipeLeft).toBeTruthy())
    await act(async () => {
      terminalProps.current!.onSwipeLeft!()
    })
    expect(selectSpy).toHaveBeenCalled()
    // 桌面有完整布局可视，不额外遮挡
    expect(screen.queryByTestId('switch-hud')).toBeNull()
  })
})
