import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalOutputScheduler } from './useTerminalOutputScheduler'
describe('useTerminalOutputScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('drains queued output when animation frames are suspended', () => {
    const write = vi.fn((_chunk: string, done?: () => void) => done?.())
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    const output = 'x'.repeat(70000)
    act(() => result.current.push(output))
    act(() => vi.advanceTimersByTime(200))
    const written = write.mock.calls.map(([chunk]) => chunk).join('')
    expect(written).toHaveLength(output.length)
    expect(written).toBe(output)
    expect(result.current.getBacklog()).toBe(0)
    act(() => result.current.dispose())
  })
  it('keeps backpressure high until queued output has actually drained', () => {
    let complete: (() => void) | undefined
    const write = vi.fn((_chunk: string, done?: () => void) => { complete = done })
    const onBackpressure = vi.fn()
    const { result } = renderHook(() => useTerminalOutputScheduler({ write, onBackpressure }))
    act(() => result.current.push('first'))
    act(() => result.current.push('x'.repeat(70000)))
    expect(onBackpressure).toHaveBeenLastCalledWith('high', 70000)
    act(() => complete?.())
    expect(onBackpressure).toHaveBeenLastCalledWith('high', 70000)
    act(() => result.current.dispose())
  })
  it('keeps the timeout fallback when more output reaches the flush limit', () => {
    const callbacks: Array<(() => void) | undefined> = []
    const write = vi.fn((_chunk: string, done?: () => void) => { callbacks.push(done) })
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    act(() => result.current.push('first'))
    act(() => result.current.push('x'.repeat(70000)))
    act(() => result.current.push('y'.repeat(70000)))
    act(() => callbacks[0]?.())
    act(() => vi.advanceTimersByTime(200))
    expect(write.mock.calls.length).toBeGreaterThan(1)
    act(() => result.current.dispose())
  })
  it('ignores completion callbacks from output discarded during resync', () => {
    const callbacks: Array<() => void> = []
    const write = vi.fn((_chunk: string, done?: () => void) => { if (done) callbacks.push(done) })
    const onWrite = vi.fn()
    const { result } = renderHook(() => useTerminalOutputScheduler({ write, onWrite }))
    act(() => result.current.push('old'))
    act(() => result.current.dispose())
    act(() => result.current.push('snapshot'))
    act(() => callbacks[0]())
    expect(onWrite).not.toHaveBeenCalled()
    act(() => result.current.push('next'))
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(['old', 'snapshot'])
    act(() => result.current.dispose())
  })
})
