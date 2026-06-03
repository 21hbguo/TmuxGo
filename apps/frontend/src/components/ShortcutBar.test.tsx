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
let windowsDataMock:any[]=[{ id:'win-1',sessionId:'session-dev',active:true }]

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send, isConnected: true, isSocketReady: true }),
}))
vi.mock('@/hooks/useApi', () => ({
  useWindows: () => ({ data: windowsDataMock }),
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
    windowsDataMock=[{ id:'win-1',sessionId:'session-dev',active:true }]
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
      vi.advanceTimersByTime(520)
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
  it('starts repeating after hold delay on touch', () => {
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    const button = screen.getByRole('button', { name: '↑' })
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(520)
    })
    expect(send.mock.calls.length).toBeGreaterThan(1)
    const beforeRelease = send.mock.calls.length
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(240)
    })
    expect(send.mock.calls.length).toBe(beforeRelease)
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
  it('keeps split and zoom available while active pane is being resynced after session switch', () => {
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-dev', activePaneId: null })
    render(React.createElement(I18nProvider, null, React.createElement(ShortcutBar)))
    expect(screen.getByRole('button', { name: '横向分割' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '聚焦' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '删面板' })).not.toBeDisabled()
  })
})
