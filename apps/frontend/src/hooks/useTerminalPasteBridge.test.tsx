import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { popKeyLayer, pushKeyLayer } from '@/lib/modal-layers'
import { useTerminalPasteBridge } from './useTerminalPasteBridge'

function collectPasteRequests() {
  const events: Array<CustomEvent<{ text?: string }>> = []
  const listener = (e: Event) => events.push(e as CustomEvent<{ text?: string }>)
  window.addEventListener('tmuxgo-request-terminal-paste', listener)
  return {
    events,
    stop: () => window.removeEventListener('tmuxgo-request-terminal-paste', listener),
  }
}

describe('useTerminalPasteBridge keyboard fallback', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fires a paste request when no paste/input event follows the shortcut', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTerminalPasteBridge())
    const { events, stop } = collectPasteRequests()
    act(() => {
      result.current.scheduleKeyboardPasteFallback()
      vi.advanceTimersByTime(160)
    })
    stop()
    expect(events).toHaveLength(1)
    expect(events[0].detail?.text).toBeUndefined()
  })

  it('drops the fallback dispatch when a modal layer is already open', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTerminalPasteBridge())
    const { events, stop } = collectPasteRequests()
    const layerId = pushKeyLayer({ getEl: () => document.body })
    act(() => {
      result.current.scheduleKeyboardPasteFallback()
      vi.advanceTimersByTime(160)
    })
    popKeyLayer(layerId)
    stop()
    expect(events).toHaveLength(0)
  })

  it('cancels the fallback when a real paste event arrives', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTerminalPasteBridge())
    const { events, stop } = collectPasteRequests()
    const paste = new Event('paste') as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? 'hello' : ''), types: ['text/plain'], files: [] },
    })
    act(() => {
      result.current.scheduleKeyboardPasteFallback()
      result.current.handlePaste(paste)
      vi.advanceTimersByTime(200)
    })
    stop()
    expect(events.map((e) => e.detail?.text)).toEqual(['hello'])
  })
})
