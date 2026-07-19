import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickActions } from './QuickActions'

const send = vi.fn()
const pushToast = vi.fn()
const updatePreferences = vi.fn()

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { attachExclusive: true }, updatePreferences }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => {
    if (key === 'quick.paste') return 'Paste'
    if (key === 'quick.copy') return 'Copy'
    return key
  } }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign(((selector: any) => selector({ activeHostId: 'local', activeSessionId: 'dev', activePaneId: '%1', pushToast })) as any, { setState: vi.fn() }),
}))
vi.mock('@/hooks/useApi', () => ({
  useWindows: () => ({ data: [{ id: '@1', active: true }] }),
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send }),
}))
vi.mock('@/hooks/useCustomShortcuts', () => ({
  useCustomShortcuts: () => ({ shortcuts: [], addShortcut: vi.fn(), removeShortcut: vi.fn() }),
  keysToEscape: vi.fn(() => ''),
}))
vi.mock('@/hooks/useSessionSnapshotSync', () => ({
  useSessionSnapshotSync: () => ({ refreshSnapshot: vi.fn(), resolveActivePaneId: vi.fn(async () => '%1'), resolveFreshActivePaneId: vi.fn(async () => '%1'), optimisticallyToggleWindowZoom: vi.fn() }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ setWindows: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({
  api: { panes: { split: vi.fn(), kill: vi.fn(), zoomByPane: vi.fn() }, windows: { create: vi.fn(), select: vi.fn(), list: vi.fn() } },
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
  it('repeats backspace while held in the mobile shortcut bar', () => {
    vi.useFakeTimers()
    render(<QuickActions mode="dock" />)
    const button = screen.getByRole('button', { name: 'Backspace' })
    fireEvent(button, createEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' }))
    act(() => vi.advanceTimersByTime(320))
    expect(send).toHaveBeenCalledWith({ type: 'input', data: '\x7f' })
    expect(send.mock.calls).toHaveLength(2)
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' })
    act(() => vi.runOnlyPendingTimers())
    expect(send.mock.calls).toHaveLength(2)
    vi.useRealTimers()
  })
})
