import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickActions } from './QuickActions'
import { api } from '@/lib/api'

const send = vi.fn()
const pushToast = vi.fn()
const updatePreferences = vi.fn()

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { attachExclusive: true }, updatePreferences }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'quick.paste') return 'Paste'
      if (key === 'quick.copy') return 'Copy'
      return key
    },
  }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign(
    ((selector: any) =>
      selector({ activeHostId: 'local', activeSessionId: 'dev', activePaneId: '%1', pushToast })) as any,
    { setState: vi.fn() },
  ),
}))
vi.mock('@/hooks/useApi', () => ({
  useWindows: () => ({ data: [{ id: '@1', active: true }] }),
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send }),
}))
const customShortcutsState = vi.hoisted(() => ({ shortcuts: [] as any[] }))
vi.mock('@/hooks/useCustomShortcuts', () => ({
  useCustomShortcuts: () => ({
    shortcuts: customShortcutsState.shortcuts,
    addShortcut: vi.fn(),
    updateShortcut: vi.fn(),
    removeShortcut: vi.fn(),
    removeShortcuts: vi.fn(),
  }),
  shortcutToSteps: (s: any) => s.steps || [],
  stepToInput: (s: any) => (s.type === 'keys' ? '\x1b[5~' : (s.text || '') + (s.appendEnter ? '\r' : '')),
  describeShortcut: vi.fn(() => ''),
  keysToEscape: vi.fn(() => ''),
}))
vi.mock('@/hooks/useSessionSnapshotSync', () => ({
  useSessionSnapshotSync: () => ({
    refreshSnapshot: vi.fn(),
    resolveActivePaneId: vi.fn(async () => '%1'),
    resolveFreshActivePaneId: vi.fn(async () => '%1'),
    optimisticallyToggleWindowZoom: vi.fn(),
    discardOptimisticWindowZoom: vi.fn(),
  }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ setWindows: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    panes: { split: vi.fn(), kill: vi.fn(), zoomByPane: vi.fn() },
    windows: { create: vi.fn(), select: vi.fn(), list: vi.fn() },
  },
}))
vi.mock('@/lib/clipboard-text', () => ({
  writeClipboardText: vi.fn(async () => ({ copied: true, source: 'system', unavailable: false })),
}))
vi.mock('@/lib/terminal-selection', () => ({
  requestTerminalSelection: vi.fn(async () => ''),
}))

describe('QuickActions', () => {
  beforeEach(() => {
    send.mockReset()
    pushToast.mockReset()
    updatePreferences.mockReset()
    customShortcutsState.shortcuts = []
    vi.mocked(api.panes.kill).mockReset()
  })
  it('keeps panel paste button from stealing terminal focus while dispatching paste', () => {
    const paste = vi.fn()
    window.addEventListener('tmuxgo-request-terminal-paste', paste)
    render(<QuickActions mode="panel" />)
    const button = screen.getByRole('button', { name: 'Paste' })
    const pointerDown = createEvent.pointerDown(button, { pointerId: 1, pointerType: 'mouse' })
    fireEvent(button, pointerDown)
    expect(pointerDown.defaultPrevented).toBe(true)
    fireEvent.click(button)
    expect(paste).toHaveBeenCalledTimes(1)
    window.removeEventListener('tmuxgo-request-terminal-paste', paste)
  })
  it('submits the kill-pane confirm only once on rapid double click', async () => {
    let resolveKill: (value: any) => void = () => {}
    const panesKill = vi.mocked(api.panes.kill)
    panesKill.mockImplementation(
      () =>
        new Promise<any>((resolve) => {
          resolveKill = resolve
        }),
    )
    render(<QuickActions mode="panel" />)
    fireEvent.click(screen.getByRole('button', { name: 'quick.killPane' }))
    const confirm = await screen.findByRole('button', { name: 'common.confirm' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(panesKill).toHaveBeenCalledTimes(1)
    expect(panesKill).toHaveBeenCalledWith('%1')
    await act(async () => resolveKill({}))
  })
  it('toasts a kill-pane failure once and allows retry', async () => {
    const panesKill = vi.mocked(api.panes.kill)
    panesKill.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce({})
    render(<QuickActions mode="panel" />)
    fireEvent.click(screen.getByRole('button', { name: 'quick.killPane' }))
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(panesKill).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })))
    // 失败后弹窗由调用方收尾关闭，重新发起可以重试
    fireEvent.click(screen.getByRole('button', { name: 'quick.killPane' }))
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(panesKill).toHaveBeenCalledTimes(2))
    expect(pushToast.mock.calls.filter(([arg]: any) => arg?.type === 'error')).toHaveLength(1)
  })
  it('dock mode keeps the add-shortcut modal hidden until opened and closable', () => {
    render(<QuickActions mode="dock" />)
    expect(screen.queryByText('shortcut.add')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'shortcut.manage' }))
    fireEvent.click(screen.getByRole('button', { name: '+ shortcut.add' }))
    expect(screen.getByText('shortcut.add')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'shortcut.cancel' }))
    expect(screen.queryByText('shortcut.add')).not.toBeInTheDocument()
  })
  it('repeats backspace while held in the mobile shortcut bar', () => {
    vi.useFakeTimers()
    render(<QuickActions mode="dock" />)
    const button = screen.getByRole('button', { name: '⌫' })
    fireEvent(button, createEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' }))
    act(() => vi.advanceTimersByTime(299))
    expect(send).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(34))
    expect(send).toHaveBeenCalledWith({ type: 'input', data: '\x7f' })
    expect(send.mock.calls).toHaveLength(2)
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' })
    act(() => vi.runOnlyPendingTimers())
    expect(send.mock.calls).toHaveLength(2)
    vi.useRealTimers()
  })
  it('repeats a hold-to-repeat custom shortcut while held in the mobile shortcut bar', () => {
    vi.useFakeTimers()
    customShortcutsState.shortcuts = [
      { id: 'pgup', label: 'PgUp', repeat: true, steps: [{ type: 'keys', keys: 'PageUp' }] },
    ]
    render(<QuickActions mode="dock" />)
    const button = screen.getByRole('button', { name: 'PgUp' })
    fireEvent(button, createEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' }))
    act(() => vi.advanceTimersByTime(419))
    expect(send).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2))
    expect(send).toHaveBeenCalledWith({ type: 'input', data: '\x1b[5~' })
    expect(send.mock.calls).toHaveLength(1)
    act(() => vi.advanceTimersByTime(140))
    expect(send.mock.calls).toHaveLength(2)
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' })
    act(() => vi.runOnlyPendingTimers())
    expect(send.mock.calls).toHaveLength(2)
    vi.useRealTimers()
  })
  it('ignores a stray pointerup on a dock button that did not start there', () => {
    render(<QuickActions mode="dock" />)
    for (const button of screen.getAllByRole('button', { name: 'Ctrl+C' })) {
      fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'mouse' })
    }
    expect(send).not.toHaveBeenCalled()
  })
  it('ignores a pointerup on a dock button when the gesture started on another button', () => {
    render(<QuickActions mode="dock" />)
    const esc = screen.getAllByRole('button', { name: 'Esc' })[0]
    const ctrlC = screen.getAllByRole('button', { name: 'Ctrl+C' })[0]
    fireEvent(esc, createEvent.pointerDown(esc, { pointerId: 1, pointerType: 'mouse' }))
    fireEvent.pointerUp(ctrlC, { pointerId: 1, pointerType: 'mouse' })
    expect(send).not.toHaveBeenCalled()
  })
  it('still fires a dock button on a normal tap', () => {
    render(<QuickActions mode="dock" />)
    const ctrlC = screen.getAllByRole('button', { name: 'Ctrl+C' })[0]
    fireEvent(ctrlC, createEvent.pointerDown(ctrlC, { pointerId: 1, pointerType: 'touch' }))
    fireEvent.pointerUp(ctrlC, { pointerId: 1, pointerType: 'touch' })
    expect(send).toHaveBeenCalledWith({ type: 'input', data: '\x03' })
  })
  it('does not repeat a custom shortcut without the repeat flag', () => {
    vi.useFakeTimers()
    customShortcutsState.shortcuts = [{ id: 'esc2', label: 'Esc2', steps: [{ type: 'keys', keys: 'Escape' }] }]
    render(<QuickActions mode="dock" />)
    const button = screen.getByRole('button', { name: 'Esc2' })
    fireEvent(button, createEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' }))
    act(() => vi.advanceTimersByTime(600))
    expect(send).not.toHaveBeenCalled()
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' })
    expect(send).toHaveBeenCalledWith({ type: 'input', data: '\x1b[5~' })
    expect(send.mock.calls).toHaveLength(1)
    vi.useRealTimers()
  })
})
