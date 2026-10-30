import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowTabs } from './WindowTabs'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { PANE_DRAG_MIME, resetPaneDrag } from '@/lib/pane-drag'
import { WINDOW_TAB_DRAG_MIME } from '@/lib/terminal-dock-drag'
import type { Window } from '@/types'

const windowsState = vi.hoisted(() => ({ value: [] as Window[] }))
const setWindowsMock = vi.hoisted(() => vi.fn())
const syncAfterWindowChangeMock = vi.hoisted(() => vi.fn(async () => null))
const writeClipboardMock = vi.hoisted(() =>
  vi.fn(async (_text: string) => ({ copied: true, source: 'system', unavailable: false, reason: 'ok' })),
)

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}))
vi.mock('@/hooks/useApi', () => ({
  useWindows: () => ({ data: windowsState.value }),
  useSessionSnapshot: () => ({ data: null }),
  useCreateWindow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBatchKillWindows: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => windowsState.value, setWindows: setWindowsMock }),
}))
vi.mock('@/hooks/useSessionSnapshotSync', () => ({
  useSessionSnapshotSync: () => ({ syncAfterWindowChange: syncAfterWindowChangeMock }),
}))
vi.mock('@/lib/clipboard-text', async () => {
  const actual = await vi.importActual<typeof import('@/lib/clipboard-text')>('@/lib/clipboard-text')
  return { ...actual, writeClipboardText: writeClipboardMock }
})

const HOST = 'local'
const SESSION = 'session-local-dev'
const LAYOUT = 'bb62,205x49,0,0[205x24,0,0,0,205x24,0,25,1]'

function createDataTransfer(payload: Record<string, string>) {
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    types: Object.keys(payload),
    setData: vi.fn(),
    getData: (type: string) => payload[type] || '',
  } as unknown as DataTransfer
}

// jsdom 没有 DragEvent：Event + 手动挂 dataTransfer/坐标，与 EditorWorkbench 测试同一套写法
function dispatchDrag(
  target: Element,
  type: 'dragstart' | 'dragover' | 'drop' | 'dragleave',
  dataTransfer: DataTransfer,
  coords: { x: number; y: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: coords.x })
  Object.defineProperty(event, 'clientY', { value: coords.y })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function tabOf(name: string): HTMLElement {
  const tab = screen.getByText(name).closest('[role="tab"]')
  if (!tab) throw new Error(`tab ${name} not found`)
  return tab as HTMLElement
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

function lastToast() {
  const toasts = useConsoleStore.getState().toasts
  return toasts[toasts.length - 1]
}

describe('WindowTabs 拓扑编辑 / 布局字符串', () => {
  beforeEach(() => {
    windowsState.value = [
      { id: 'local:@1', sessionId: SESSION, index: 0, name: 'editor', active: true },
      { id: 'local:@2', sessionId: SESSION, index: 1, name: 'logs', active: false, tmuxWindowId: '@2' },
    ]
    useConsoleStore.setState({
      activeHostId: HOST,
      activeSessionId: SESSION,
      toasts: [],
      connection: { status: 'connected', latency: 0, lastPing: new Date().toISOString() },
    })
    vi.spyOn(api.windows, 'list').mockResolvedValue(windowsState.value)
    vi.spyOn(api.windows, 'move').mockResolvedValue({ ok: true, windows: windowsState.value })
    vi.spyOn(api.panes, 'move').mockResolvedValue({ ok: true })
    vi.spyOn(api.layoutString, 'get').mockResolvedValue({ ok: true, windowId: '@2', layout: LAYOUT, panes: 2 })
    vi.spyOn(api.layoutString, 'apply').mockResolvedValue({ ok: true, windowId: '@2', panes: 2 })
    writeClipboardMock.mockClear()
    setWindowsMock.mockClear()
    syncAfterWindowChangeMock.mockClear()
    resetPaneDrag()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('drops a pane on a window tab and calls move with host-prefixed pane/window ids', async () => {
    render(<WindowTabs />)
    const tab = tabOf('logs')
    const dataTransfer = createDataTransfer({
      [PANE_DRAG_MIME]: JSON.stringify({ paneId: 'local:%5', windowId: 'local:@1', title: 'shell' }),
    })

    dispatchDrag(tab, 'dragover', dataTransfer, { x: 10, y: 10 })
    expect(tab.className).toContain('ring-accent')

    dispatchDrag(tab, 'drop', dataTransfer, { x: 10, y: 10 })
    await waitFor(() => expect(api.panes.move).toHaveBeenCalledWith('local:%5', { targetWindowId: 'local:@2' }))
    await waitFor(() => expect(api.windows.list).toHaveBeenCalledWith(HOST, SESSION))
    expect(setWindowsMock).toHaveBeenCalledWith(windowsState.value)
    expect(syncAfterWindowChangeMock).toHaveBeenCalled()
    expect(lastToast()).toMatchObject({ type: 'success', message: 'pane.moveToWindowSuccess {"name":"logs"}' })
  })

  it('refuses to move a pane onto its own window tab', async () => {
    render(<WindowTabs />)
    const tab = tabOf('editor')
    const dataTransfer = createDataTransfer({
      [PANE_DRAG_MIME]: JSON.stringify({ paneId: 'local:%5', windowId: 'local:@1' }),
    })
    dispatchDrag(tab, 'drop', dataTransfer, { x: 10, y: 10 })
    await waitFor(() => expect(lastToast()).toMatchObject({ type: 'info', message: 'pane.moveSameWindow' }))
    expect(api.panes.move).not.toHaveBeenCalled()
  })

  it('keeps window tab reordering working (separate MIME, no pane move)', async () => {
    render(<WindowTabs />)
    const source = tabOf('editor')
    const target = tabOf('logs')
    stubRect(target, { left: 0, top: 0, width: 100, height: 30 })
    const dataTransfer = createDataTransfer({ [WINDOW_TAB_DRAG_MIME]: 'local:@1' })

    dispatchDrag(source, 'dragstart', dataTransfer, { x: 5, y: 5 })
    dispatchDrag(target, 'dragover', dataTransfer, { x: 80, y: 10 })
    dispatchDrag(target, 'drop', dataTransfer, { x: 80, y: 10 })

    await waitFor(() => expect(api.windows.move).toHaveBeenCalledWith(HOST, SESSION, ['local:@2', 'local:@1']))
    expect(api.panes.move).not.toHaveBeenCalled()
  })

  it('copies the raw tmux layout string of the window from the tab menu', async () => {
    render(<WindowTabs />)
    fireEvent.contextMenu(tabOf('logs'), { clientX: 40, clientY: 30 })
    fireEvent.click(await screen.findByTestId('window-copy-layout'))

    await waitFor(() => expect(api.layoutString.get).toHaveBeenCalledWith(HOST, SESSION, '@2'))
    expect(writeClipboardMock).toHaveBeenCalledWith(LAYOUT)
    await waitFor(() => expect(lastToast()).toMatchObject({ type: 'success', message: 'window.layoutCopied' }))
  })

  it('applies a pasted layout string and refreshes the window state', async () => {
    render(<WindowTabs />)
    fireEvent.contextMenu(tabOf('logs'), { clientX: 40, clientY: 30 })
    fireEvent.click(await screen.findByTestId('window-apply-layout'))

    const input = await screen.findByTestId('layout-string-input')
    fireEvent.change(input, { target: { value: `  ${LAYOUT}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'window.layoutApplyConfirm' }))

    await waitFor(() =>
      expect(api.layoutString.apply).toHaveBeenCalledWith(HOST, SESSION, { windowId: '@2', layout: LAYOUT }),
    )
    await waitFor(() => expect(syncAfterWindowChangeMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('layout-string-input')).toBeNull())
    expect(lastToast()).toMatchObject({ type: 'success', message: 'window.layoutApplySuccess' })
  })

  it('shows the backend message in the dialog when apply returns 400', async () => {
    vi.mocked(api.layoutString.apply).mockRejectedValueOnce(
      new Error('LAYOUT_PANE_MISMATCH: layout expects 3 panes, window has 2'),
    )
    render(<WindowTabs />)
    fireEvent.contextMenu(tabOf('logs'), { clientX: 40, clientY: 30 })
    fireEvent.click(await screen.findByTestId('window-apply-layout'))

    fireEvent.change(await screen.findByTestId('layout-string-input'), { target: { value: LAYOUT } })
    fireEvent.click(screen.getByRole('button', { name: 'window.layoutApplyConfirm' }))

    const error = await screen.findByTestId('layout-string-error')
    expect(error.textContent).toBe('LAYOUT_PANE_MISMATCH: layout expects 3 panes, window has 2')
    // 失败不关弹窗：用户要能改完再试
    expect(screen.getByTestId('layout-string-input')).toBeInTheDocument()
    expect(syncAfterWindowChangeMock).not.toHaveBeenCalled()
  })
})
