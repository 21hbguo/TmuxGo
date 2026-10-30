import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneGrid } from './PaneGrid'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { PANE_DRAG_MIME, getPaneDrag, resetPaneDrag } from '@/lib/pane-drag'
import type { Host, Pane, Session, Window } from '@/types'

// pane 拓扑手势的接线断言：把手 → 单例 → 落点层 → move；右键 → break。
// 坐标/半边判定由 pane-drag 与 PaneMoveOverlay 的单测覆盖，这里只钉装配。
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
const hostsMockData = vi.hoisted(() => ({ value: [{ id: 'local' }] as Array<Pick<Host, 'id'>> | undefined }))
const snapshotMockData = vi.hoisted(() => ({ value: null as MockSnapshot | null }))
const refreshSnapshotMock = vi.hoisted(() => vi.fn(async () => null))

vi.mock('./TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}))
vi.mock('./SnapshotResumeHint', () => ({ SnapshotResumeHint: () => null }))
vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: () => ({ prompt: vi.fn(async () => null), PromptElement: null }),
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    send: sendMock,
    isConnected: socketState.isConnected,
    isSocketReady: socketState.isSocketReady,
    subscribeOutput: subscribeOutputMock,
    retryConnection: vi.fn(),
    getLastMirrorSeq: () => null,
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
vi.mock('@/hooks/useMobileKeyboard', () => ({ isMobileDevice: () => false }))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: hostsMockData.value }),
  useWindows: () => ({ data: [] }),
  useSessionSnapshot: () => ({ data: snapshotMockData.value }),
  useSyncPanes: () => ({ data: { panes: [], max: 16 } }),
  useSetSyncPanes: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: [] as Array<Pick<Session, 'id'>> }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => [], setWindows: vi.fn() }),
}))
vi.mock('@/hooks/useSessionSnapshotSync', () => ({
  useSessionSnapshotSync: () => ({
    syncAfterWindowChange: vi.fn(),
    refreshSnapshot: refreshSnapshotMock,
    resolveActivePaneId: vi.fn(),
    resolveFreshActivePaneId: vi.fn(),
    optimisticallyToggleWindowZoom: vi.fn(),
    discardOptimisticWindowZoom: vi.fn(),
  }),
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

function createDataTransfer(payload: Record<string, string>) {
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    types: Object.keys(payload),
    setData: vi.fn(),
    getData: (type: string) => payload[type] || '',
  } as unknown as DataTransfer
}

function dispatchDrag(
  target: Element,
  type: 'dragstart' | 'dragover' | 'drop',
  dataTransfer: DataTransfer,
  coords = { x: 0, y: 0 },
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: coords.x })
  Object.defineProperty(event, 'clientY', { value: coords.y })
  act(() => {
    target.dispatchEvent(event)
  })
}

function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
    }),
  })
}

describe('PaneGrid 拓扑编辑接线', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    vi.spyOn(api.panes, 'move').mockResolvedValue({ ok: true })
    vi.spyOn(api.panes, 'break').mockResolvedValue({ ok: true })
    refreshSnapshotMock.mockClear()
    snapshotMockData.value = {
      windows: [{ id: 'local:@1', sessionId: 'session-local-dev', index: 0, name: 'dev', active: true, zoomed: false }],
      panes: [
        {
          id: 'local:%1',
          windowId: 'local:@1',
          index: 0,
          title: 'left',
          active: true,
          left: 0,
          top: 0,
          size: { cols: 80, rows: 24 },
        },
        {
          id: 'local:%2',
          windowId: 'local:@1',
          index: 1,
          title: 'right',
          active: false,
          left: 80,
          top: 0,
          size: { cols: 80, rows: 24 },
        },
      ],
      activeWindowId: 'local:@1',
      activePaneId: 'local:%1',
    }
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-local-dev',
      activePaneId: 'local:%1',
      toasts: [],
      connection: { status: 'connected', latency: 0, lastPing: new Date().toISOString() },
    })
    resetPaneDrag()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetPaneDrag()
  })

  it('starts a pane drag from the handle and paints drop regions for the other panes', async () => {
    render(<PaneGrid />)
    const handle = await screen.findByTestId('pane-drag-handle')
    const dataTransfer = createDataTransfer({})
    dispatchDrag(handle, 'dragstart', dataTransfer)

    expect(getPaneDrag()).toMatchObject({ paneId: 'local:%1', windowId: 'local:@1' })
    expect(screen.getByTestId('pane-move-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('pane-drop-local:%2')).toBeInTheDocument()
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      PANE_DRAG_MIME,
      JSON.stringify({ paneId: 'local:%1', windowId: 'local:@1', title: 'left' }),
    )
  })

  it('drops on the right half of another pane and calls move with horizontal', async () => {
    render(<PaneGrid />)
    const handle = await screen.findByTestId('pane-drag-handle')
    const dataTransfer = createDataTransfer({
      [PANE_DRAG_MIME]: JSON.stringify({ paneId: 'local:%1', windowId: 'local:@1' }),
    })
    dispatchDrag(handle, 'dragstart', dataTransfer)

    const region = screen.getByTestId('pane-drop-local:%2')
    stubRect(region, { left: 0, top: 0, width: 200, height: 100 })
    dispatchDrag(region, 'dragover', dataTransfer, { x: 180, y: 50 })
    dispatchDrag(region, 'drop', dataTransfer, { x: 180, y: 50 })

    await waitFor(() =>
      expect(api.panes.move).toHaveBeenCalledWith('local:%1', { targetPaneId: 'local:%2', direction: 'horizontal' }),
    )
    await waitFor(() => expect(refreshSnapshotMock).toHaveBeenCalled())
    // 成功后落点层要收掉
    await waitFor(() => expect(screen.queryByTestId('pane-move-overlay')).toBeNull())
  })

  it('cancels the pane drag on Escape', async () => {
    render(<PaneGrid />)
    const handle = await screen.findByTestId('pane-drag-handle')
    dispatchDrag(handle, 'dragstart', createDataTransfer({ [PANE_DRAG_MIME]: JSON.stringify({ paneId: 'local:%1' }) }))
    expect(screen.getByTestId('pane-move-overlay')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('pane-move-overlay')).toBeNull())
    expect(getPaneDrag()).toBeNull()
  })

  it('breaks the pane out into a new window from the pane context menu', async () => {
    render(<PaneGrid />)
    const handle = await screen.findByTestId('pane-drag-handle')
    fireEvent.contextMenu(handle, { clientX: 40, clientY: 20 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '移入新窗口' }))

    await waitFor(() => expect(api.panes.break).toHaveBeenCalledWith('local:%1'))
    await waitFor(() => expect(refreshSnapshotMock).toHaveBeenCalled())
    const toasts = useConsoleStore.getState().toasts
    expect(toasts[toasts.length - 1]).toMatchObject({ type: 'success', message: '已移入新窗口' })
  })
})
