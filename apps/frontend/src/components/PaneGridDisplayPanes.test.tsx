import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneGrid } from './PaneGrid'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { Host, Pane, Session, Window } from '@/types'

// display-panes 编号层的集成断言：Alt+p 唤起、数字跳 pane、zoom 退化成 window 级
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
  useSyncPanes: () => ({ data: undefined }),
  useSetSyncPanes: () => ({ mutate: vi.fn() }),
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

describe('PaneGrid display-panes', () => {
  beforeEach(() => {
    // 与 PaneGrid.test.tsx 同一条教训：这文件用真 useSessionSnapshotSync，切窗口会打真网络
    vi.spyOn(api.snapshot, 'get').mockResolvedValue({
      windows: [],
      panes: [],
      activeWindowId: null,
      activePaneId: null,
    } as never)
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
      activePaneId: 'local:%1',
      connection: { status: 'connected', latency: 0, lastPing: new Date().toISOString() },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // 拆两个 pane 左右各半，编号层要按 tmux 几何比例铺上去
  function seedTwoPanes(options: { zoomed?: boolean } = {}) {
    windowsData.push({ id: 'local:@1', sessionId: 'session-dev1', active: true, name: 'dev', zoomed: !!options.zoomed })
    windowsData.push({ id: 'local:@2', sessionId: 'session-dev1', active: false, name: 'ops' })
    snapshotMockData.value = {
      windows: [
        { id: 'local:@1', zoomed: !!options.zoomed },
        { id: 'local:@2', zoomed: false },
      ],
      panes: [
        { id: 'local:%1', windowId: 'local:@1', index: 0, left: 0, top: 0, size: { cols: 80, rows: 24 } },
        { id: 'local:%2', windowId: 'local:@1', index: 1, left: 80, top: 0, size: { cols: 80, rows: 24 } },
      ],
      activeWindowId: 'local:@1',
      activePaneId: 'local:%1',
    }
  }

  function pressAltP() {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', altKey: true, bubbles: true, cancelable: true }))
    })
  }

  it('opens the number layer on Alt+p with one badge per visible pane', async () => {
    seedTwoPanes()
    render(<PaneGrid />)
    await waitFor(() => expect(terminalProps.current).toBeTruthy())
    expect(screen.queryByTestId('pane-number-overlay')).toBeNull()
    pressAltP()
    const overlay = screen.getByTestId('pane-number-overlay')
    expect(overlay.dataset.mode).toBe('panes')
    expect(screen.getByTestId('pane-number-1')).toBeTruthy()
    expect(screen.getByTestId('pane-number-2').style.left).toBe('50%')
  })

  it('jumps to the pane whose number is pressed', async () => {
    seedTwoPanes()
    const selectSpy = vi.spyOn(api.panes, 'select').mockResolvedValue({ ok: true })
    render(<PaneGrid />)
    await waitFor(() => expect(terminalProps.current).toBeTruthy())
    pressAltP()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    expect(selectSpy).toHaveBeenCalledWith('local:%2', { keepZoom: false })
    expect(screen.queryByTestId('pane-number-overlay')).toBeNull()
  })

  it('closes on Escape without selecting anything', async () => {
    seedTwoPanes()
    const selectSpy = vi.spyOn(api.panes, 'select').mockResolvedValue({ ok: true })
    render(<PaneGrid />)
    await waitFor(() => expect(terminalProps.current).toBeTruthy())
    pressAltP()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(screen.queryByTestId('pane-number-overlay')).toBeNull()
    expect(selectSpy).not.toHaveBeenCalled()
  })

  it('degrades to window numbering when the window is zoomed', async () => {
    seedTwoPanes({ zoomed: true })
    const windowSpy = vi.spyOn(api.windows, 'select').mockResolvedValue({ ok: true, windows: [] })
    render(<PaneGrid />)
    await waitFor(() => expect(terminalProps.current).toBeTruthy())
    pressAltP()
    // zoom 态 pane 几何不可见 → 只给 window 编号
    expect(screen.getByTestId('pane-number-overlay').dataset.mode).toBe('windows')
    expect(screen.getByTestId('window-number-2').textContent).toContain('ops')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    expect(windowSpy).toHaveBeenCalledWith('local', 'session-dev1', 'local:@2')
  })
})
