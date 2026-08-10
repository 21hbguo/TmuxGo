import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'
import { ShortcutBar } from './ShortcutBar'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'

const send = vi.fn()
const snapshotGet = vi.fn()
const zoomByPane = vi.fn()
const killPane = vi.fn()
const removeShortcut = vi.fn()
const removeShortcuts = vi.fn()
let windowsDataMock:any[]=[{ id:'win-1',sessionId:'session-dev',active:true }]
const shortcutsMock=[{ id:'shortcut-a',label:'A',keys:'Ctrl+A',action:'input' },{ id:'shortcut-b',label:'B',keys:'Ctrl+B',action:'input' },{ id:'shortcut-text',label:'Status',mode:'text' as const,text:'printf ok',appendEnter:true },{ id:'shortcut-macro',label:'Deploy',steps:[{ type:'text',text:'cd /app',appendEnter:true },{ type:'wait',ms:500 },{ type:'keys',keys:'Ctrl+A' }] }]

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send, isConnected: true, isSocketReady: true }),
}))
vi.mock('@/hooks/useApi', () => ({
  useWindows: () => ({ data: windowsDataMock }),
}))
vi.mock('@/hooks/useCustomShortcuts', () => ({
  useCustomShortcuts: () => ({ shortcuts: shortcutsMock, addShortcut: vi.fn(), updateShortcut: vi.fn(), removeShortcut, removeShortcuts }),
  shortcutToSteps: (value: any) => value.steps || (value.mode === 'text' ? [{ type: 'text', text: value.text, appendEnter: value.appendEnter }] : [{ type: 'keys', keys: value.keys }]),
  stepToInput: (step: any) => step.type === 'text' ? step.text + (step.appendEnter ? '\r' : '') : step.keys === 'Ctrl+A' ? '\x01' : step.keys === 'Ctrl+B' ? '\x02' : '',
  describeShortcut: () => '',
}))
vi.mock('@/lib/api', () => ({
  api: {
    snapshot: { get: (...args: any[]) => snapshotGet(...args) },
    panes: { zoomByPane: (...args: any[]) => zoomByPane(...args), kill: (...args: any[]) => killPane(...args) },
  },
}))

describe('ShortcutBar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    send.mockClear()
    snapshotGet.mockReset()
    zoomByPane.mockReset()
    killPane.mockReset()
    removeShortcut.mockReset()
    removeShortcuts.mockReset()
    windowsDataMock=[{ id:'win-1',sessionId:'session-dev',active:true }]
    window.localStorage.clear()
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-dev', activePaneId: 'old-pane' })
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })
  it('stops repeating keys on global pointer release', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    fireEvent.pointerDown(screen.getByRole('button', { name: '↑' }))
    act(() => {
      vi.advanceTimersByTime(720)
    })
    expect(send.mock.calls.length).toBeGreaterThan(1)
    const beforeRelease = send.mock.calls.length
    fireEvent.pointerUp(window)
    act(() => {
      vi.advanceTimersByTime(240)
    })
    expect(send.mock.calls.length).toBe(beforeRelease)
  })
  it('does not trigger button action while dragging across shortcut bar', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: '聚焦' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    send.mockClear()
    fireEvent.pointerMove(button, { pointerId: 1, pointerType: 'touch', clientX: 28, clientY: 10 })
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 28, clientY: 10 })
    expect(send).not.toHaveBeenCalled()
    expect(zoomByPane).not.toHaveBeenCalled()
  })
  it('does not trigger shortcut when the bar itself scrolls', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const bar=document.querySelector('[data-shortcut-bar]') as HTMLDivElement
    const button=screen.getByRole('button', { name: 'Enter' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    bar.scrollLeft=42
    fireEvent.scroll(bar)
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 12, clientY: 10 })
    expect(send).not.toHaveBeenCalled()
  })
  it('allows a stationary zoom tap after the previous dock scroll', async () => {
    snapshotGet.mockResolvedValue({ windows: [], panes: [{ id: 'local:%2', active: true }], activePaneId: 'local:%2' })
    zoomByPane.mockResolvedValue({ ok: true })
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const bar=document.querySelector('[data-shortcut-bar]') as HTMLDivElement
    bar.scrollLeft=42
    fireEvent.scroll(bar)
    await act(async () => {
      const button=screen.getByRole('button', { name: '聚焦' })
      fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    })
    expect(zoomByPane).toHaveBeenCalledTimes(1)
  })
  it('waits until touch release before sending non-repeat shortcut data', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: 'Enter' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(send).not.toHaveBeenCalled()
    fireEvent.pointerMove(button, { pointerId: 1, pointerType: 'touch', clientX: 26, clientY: 10 })
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 26, clientY: 10 })
    expect(send).not.toHaveBeenCalled()
  })
  it('sends a single repeat key on touch tap release', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: '↑' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(send).not.toHaveBeenCalled()
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ type: 'input', data: '\u001b[A' })
  })
  it('ignores the delayed click after a touch repeat key release', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: '↑' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.click(button, { detail: 1 })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('starts repeating after hold delay on touch', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: '↑' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(720)
    })
    expect(send.mock.calls.length).toBeGreaterThan(1)
    const beforeRelease = send.mock.calls.length
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(240)
    })
    expect(send.mock.calls.length).toBe(beforeRelease)
  })
  it('throttles vertical arrow repeat after the initial hold delay', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: '↓' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(419)
    })
    expect(send).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(421)
    })
    expect(send).toHaveBeenCalledTimes(4)
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
  })
  it('prevents default on touch pointerdown so mobile keyboard stays open', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button=screen.getByRole('button', { name: 'Enter' })
    const event=createEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent(button, event)
    expect(event.defaultPrevented).toBe(true)
  })
  it('uses latest active pane from snapshot for zoom', async () => {
    snapshotGet.mockResolvedValue({ windows: [], panes: [{ id: 'local:%2', active: true }], activePaneId: 'local:%2' })
    zoomByPane.mockResolvedValue({ ok: true })
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    await act(async () => {
      const button = screen.getByRole('button', { name: '聚焦' })
      fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, clientX: 10, clientY: 10 })
    })
    expect(zoomByPane).toHaveBeenCalledWith('local:%2')
    expect(useConsoleStore.getState().activePaneId).toBe('local:%2')
  })
  it('does not toggle zoom twice when touch produces a delayed click', async () => {
    snapshotGet.mockResolvedValue({ windows: [], panes: [{ id: 'local:%2', active: true }], activePaneId: 'local:%2' })
    zoomByPane.mockResolvedValue({ ok: true })
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    await act(async () => {
      const button = screen.getByRole('button', { name: '聚焦' })
      fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
      fireEvent.click(button, { detail: 1 })
    })
    expect(zoomByPane).toHaveBeenCalledTimes(1)
    expect(zoomByPane).toHaveBeenCalledWith('local:%2')
  })
  it('marks cached snapshot zoomed before the zoom request resolves', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const snapshot = {
      sessionName: 'dev',
      activeWindowId: 'local:@1',
      windows: [{ id: 'local:@1', sessionId: 'session-dev', index: 0, active: true, zoomed: false }],
      panes: [{ id: 'local:%2', windowId: 'local:@1', active: true }],
      activePaneId: 'local:%2',
    }
    queryClient.setQueryData(['session-snapshot', 'local', 'session-dev'], snapshot)
    snapshotGet.mockResolvedValue(snapshot)
    let resolveZoom: (value: { ok: boolean }) => void = () => {}
    zoomByPane.mockReturnValue(new Promise((resolve) => {
      resolveZoom = resolve
    }))
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(ShortcutBar))))
    await act(async () => {
      const button = screen.getByRole('button', { name: '聚焦' })
      fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, clientX: 10, clientY: 10 })
      await Promise.resolve()
    })
    const cached: any = queryClient.getQueryData(['session-snapshot', 'local', 'session-dev'])
    expect(cached?.windows?.[0]?.zoomed).toBe(true)
    expect(cached?.activePaneId).toBe('local:%2')
    resolveZoom({ ok: true })
    await act(async () => {
      await Promise.resolve()
    })
  })
  it('does not reuse stale pane id when snapshot refresh fails', async () => {
    snapshotGet.mockRejectedValue(new Error('Request failed'))
    zoomByPane.mockResolvedValue({ ok: true })
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    await act(async () => {
      const button = screen.getByRole('button', { name: '聚焦' })
      fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, clientX: 10, clientY: 10 })
    })
    expect(zoomByPane).not.toHaveBeenCalled()
    expect(useConsoleStore.getState().activePaneId).toBeNull()
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('当前没有可操作的面板')
  })
  it('does not show error when kill succeeds but snapshot refresh fails afterward', async () => {
    snapshotGet.mockResolvedValueOnce({ windows: [], panes: [{ id: 'local:%3', active: true }], activePaneId: 'local:%3' }).mockRejectedValueOnce(new Error('Request failed'))
    killPane.mockResolvedValue({ ok: true })
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    await act(async () => {
      const button = screen.getByRole('button', { name: '删面板' })
      fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, clientX: 10, clientY: 10 })
    })
    expect(killPane).not.toHaveBeenCalled()
    expect(screen.getByText('确认')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByText('确认'))
    })
    expect(killPane).toHaveBeenCalledWith('local:%3')
  })
  it('uses the latest pane when closing through a standard click', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    queryClient.setQueryData(['session-snapshot', 'local', 'session-dev'], { windows: [], panes: [{ id: 'local:%old', active: true }], activePaneId: 'local:%old' })
    snapshotGet.mockResolvedValue({ windows: [], panes: [{ id: 'local:%4', active: true }], activePaneId: 'local:%4' })
    killPane.mockResolvedValue({ ok: true })
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(ShortcutBar))))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删面板' }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('确认')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByText('确认'))
      await Promise.resolve()
    })
    expect(killPane).toHaveBeenCalledWith('local:%4')
  })
  it('tracks expected zoom state across clicks so stale cached snapshot does not desync from tmux', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const cachedSnapshot = {
      sessionName: 'dev',
      activeWindowId: 'local:@1',
      windows: [{ id: 'local:@1', sessionId: 'session-dev', index: 0, active: true, zoomed: false }],
      panes: [{ id: 'local:%2', windowId: 'local:@1', active: true }],
      activePaneId: 'local:%2',
    }
    const liveSnapshot = { ...cachedSnapshot, windows: [{ ...cachedSnapshot.windows[0], zoomed: true }] }
    queryClient.setQueryData(['session-snapshot', 'local', 'session-dev'], cachedSnapshot)
    let snapshotCalls = 0
    snapshotGet.mockImplementation(async () => {
      snapshotCalls += 1
      return snapshotCalls === 1 ? cachedSnapshot : liveSnapshot
    })
    zoomByPane.mockResolvedValue({ ok: true })
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(ShortcutBar))))
    await act(async () => {
      const button = screen.getByRole('button', { name: '聚焦' })
      fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, clientX: 10, clientY: 10 })
      await Promise.resolve()
    })
    const cachedAfterFirst: any = queryClient.getQueryData(['session-snapshot', 'local', 'session-dev'])
    expect(cachedAfterFirst?.windows?.[0]?.zoomed).toBe(true)
    await act(async () => {
      const button = screen.getByRole('button', { name: '聚焦' })
      fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(button, { pointerId: 1, clientX: 10, clientY: 10 })
      await Promise.resolve()
    })
    const cachedAfterSecond: any = queryClient.getQueryData(['session-snapshot', 'local', 'session-dev'])
    expect(cachedAfterSecond?.windows?.[0]?.zoomed).toBe(false)
  })
  it('keeps split and zoom available while active pane is being resynced after session switch', () => {
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-dev', activePaneId: null })
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    expect(screen.getByRole('button', { name: '横向分割' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '聚焦' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '删面板' })).not.toBeDisabled()
  })
  it('shows keyboard dock core buttons', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    expect(screen.getAllByRole('button', { name: 'Esc' }).length).toBeGreaterThan(1)
    expect(screen.getAllByRole('button', { name: 'Tab' }).length).toBeGreaterThan(1)
    expect(screen.getAllByRole('button', { name: 'Ctrl+C' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Ctrl+D' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ctrl+Z' })).toBeTruthy()
  })
  it('opens the mobile files tab from the dock', () => {
    const openFiles=vi.fn()
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar, { onOpenFiles: openFiles })))
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(openFiles).toHaveBeenCalledTimes(1)
  })
  it('moves recently used custom shortcut to the front in dock mode', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const buttonsBefore = screen.getAllByRole('button').map((item) => item.textContent)
    expect(buttonsBefore.indexOf('A')).toBeLessThan(buttonsBefore.indexOf('B'))
    expect(buttonsBefore.indexOf('A')).toBeLessThan(buttonsBefore.indexOf('Esc'))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'B' }), { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(screen.getByRole('button', { name: 'B' }), { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    const rerendered = render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const buttonsAfter = rerendered.getAllByRole('button').map((item) => item.textContent)
    expect(buttonsAfter.indexOf('B')).toBeLessThan(buttonsAfter.indexOf('A'))
  })
  it('shows a single edit/delete pair in the section header for custom shortcuts', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar, { mode: 'panel' })))
    expect(screen.getAllByRole('button', { name: '编辑快捷键' })).toHaveLength(1)
    const deleteButton=screen.getByRole('button', { name: '删除快捷键' })
    expect(deleteButton).toBeDisabled()
    expect(deleteButton.className).toContain('h-6')
    expect(deleteButton.className).toContain('w-6')
  })
  it('selects a shortcut in manage mode, edits it, and exits', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar, { mode: 'panel' })))
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(send).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '编辑快捷键' }))
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(send).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '编辑快捷键' }))
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑快捷键' }))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })
  it('confirms before removing a custom shortcut', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar, { mode: 'panel' })))
    fireEvent.click(screen.getByRole('button', { name: '编辑快捷键' }))
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    const deleteButton=screen.getByRole('button', { name: '删除快捷键' })
    expect(deleteButton).not.toBeDisabled()
    fireEvent.click(deleteButton)
    expect(removeShortcut).not.toHaveBeenCalled()
    expect(screen.getByText('确定删除快捷键“A”？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(removeShortcut).not.toHaveBeenCalled()
    fireEvent.click(deleteButton)
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(removeShortcuts).toHaveBeenCalledWith(['shortcut-a'])
    expect(screen.getByRole('button', { name: '删除快捷键' })).toBeDisabled()
  })
  it('confirms before batch removing multiple selected shortcuts', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar, { mode: 'panel' })))
    fireEvent.click(screen.getByRole('button', { name: '编辑快捷键' }))
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    fireEvent.click(screen.getByRole('button', { name: '删除快捷键' }))
    expect(screen.getByText('确定删除选中的 2 个快捷键？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(removeShortcuts).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除快捷键' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(removeShortcuts).toHaveBeenCalledWith(['shortcut-a', 'shortcut-b'])
    expect(screen.getByRole('button', { name: '删除快捷键' })).toBeDisabled()
  })
  it('opens the shortcut manage sheet from dock and deletes a shortcut', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    fireEvent.click(screen.getByRole('button', { name: '管理快捷键' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '删除快捷键' })).toHaveLength(shortcutsMock.length)
    fireEvent.click(screen.getAllByRole('button', { name: '删除快捷键' })[0])
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(removeShortcuts).toHaveBeenCalledWith(['shortcut-a'])
  })
  it('sends text shortcuts and appends enter only when configured', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: 'Status' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(send).toHaveBeenCalledWith({ type: 'input', data: 'printf ok\r' })
  })
  it('runs macro steps in order with wait between them', async () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: 'Deploy' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ type: 'input', data: 'cd /app\r' })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith({ type: 'input', data: '\x01' })
  })
  it('cancels pending macro steps when another shortcut fires', async () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const deploy = screen.getByRole('button', { name: 'Deploy' })
    fireEvent.pointerDown(deploy, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(deploy, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(send).toHaveBeenCalledTimes(1)
    const a = screen.getByRole('button', { name: 'A' })
    fireEvent.pointerDown(a, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(a, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('shows running state on a macro button while it executes', async () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: 'Deploy' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(button.className).toContain('animate-pulse')
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(screen.getByRole('button', { name: 'Deploy' }).className).not.toContain('animate-pulse')
  })
})
