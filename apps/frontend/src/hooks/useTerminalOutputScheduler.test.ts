import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalOutputScheduler } from './useTerminalOutputScheduler'
describe('useTerminalOutputScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('writes the first sparse output chunk immediately', () => {
    const write = vi.fn((_chunk: string, done?: () => void) => done?.())
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    act(() => result.current.push('prompt'))
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('prompt', expect.any(Function))
    act(() => result.current.dispose())
  })
  it('coalesces chunks pushed while a write is in flight', () => {
    const callbacks: Array<(() => void) | undefined> = []
    const write = vi.fn((_chunk: string, done?: () => void) => {
      callbacks.push(done)
    })
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    act(() => {
      result.current.push('a')
      result.current.push('b')
      result.current.push('c')
    })
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(['a'])
    act(() => callbacks[0]?.())
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(['a', 'bc'])
    act(() => result.current.dispose())
  })
  it('returns to the direct-write fast path after the burst window', () => {
    const write = vi.fn((_chunk: string, done?: () => void) => done?.())
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    act(() => result.current.push('first'))
    act(() => vi.advanceTimersByTime(9))
    act(() => result.current.push('second'))
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(['first', 'second'])
    act(() => result.current.dispose())
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
    const write = vi.fn((_chunk: string, done?: () => void) => {
      complete = done
    })
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
    const write = vi.fn((_chunk: string, done?: () => void) => {
      callbacks.push(done)
    })
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
    const write = vi.fn((_chunk: string, done?: () => void) => {
      if (done) callbacks.push(done)
    })
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
  it('resolves afterWrites immediately when no output is queued or in flight', () => {
    const write = vi.fn((_chunk: string, done?: () => void) => done?.())
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    const barrier = vi.fn()
    act(() => result.current.afterWrites(barrier))
    expect(barrier).toHaveBeenCalledTimes(1)
    act(() => result.current.dispose())
  })
  it('holds afterWrites until an in-flight write callback completes', () => {
    let complete: (() => void) | undefined
    const write = vi.fn((_chunk: string, done?: () => void) => {
      complete = done
    })
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    const barrier = vi.fn()
    act(() => result.current.push('chunk'))
    act(() => result.current.afterWrites(barrier))
    expect(barrier).not.toHaveBeenCalled()
    act(() => complete?.())
    expect(barrier).toHaveBeenCalledTimes(1)
    act(() => result.current.dispose())
  })
  it('holds afterWrites until buffered backlog has fully drained', () => {
    const callbacks: Array<(() => void) | undefined> = []
    const write = vi.fn((_chunk: string, done?: () => void) => {
      callbacks.push(done)
    })
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    const barrier = vi.fn()
    act(() => result.current.push('first'))
    act(() => result.current.push('second'))
    act(() => result.current.afterWrites(barrier))
    act(() => callbacks[0]?.())
    // 'second' 现在才进 write：屏障必须等到它也落屏
    expect(barrier).not.toHaveBeenCalled()
    act(() => callbacks[1]?.())
    expect(barrier).toHaveBeenCalledTimes(1)
    act(() => result.current.dispose())
  })
  it('bounds the afterWrites wait when the write callback never fires', () => {
    // 有界降级：write 回调始终不来时超时仍放行 barrier——这不是严格"写完成"证明，
    // 只是防止慢写/丢回调把遮罩永久卡死的兜底，调用方不得据此断言首帧已绘制
    const write = vi.fn((_chunk: string, _done?: () => void) => {})
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    const barrier = vi.fn()
    act(() => result.current.push('chunk'))
    act(() => result.current.afterWrites(barrier))
    expect(barrier).not.toHaveBeenCalled()
    // 160ms 内有界等待，write 未完成；超时后降级放行
    act(() => vi.advanceTimersByTime(150))
    expect(barrier).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(50))
    expect(barrier).toHaveBeenCalledTimes(1)
    act(() => result.current.dispose())
  })
  it('resolves afterWrites once the bytes queued at call time are written, ignoring later arrivals', () => {
    // 时间点屏障：resize ACK 到达时只需等当时已入队的 resize 帧写完；
    // 之后持续到达的输出（如左 pane 洪流）不延长揭罩等待
    const callbacks: Array<(() => void) | undefined> = []
    const write = vi.fn((_chunk: string, done?: () => void) => {
      callbacks.push(done)
    })
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    const barrier = vi.fn()
    act(() => result.current.push('resize-frame'))
    act(() => result.current.afterWrites(barrier))
    // 屏障建立后再到的输出不得计入等待目标
    act(() => result.current.push('flood'))
    act(() => callbacks[0]?.())
    // 'resize-frame' 写完即放行，尽管 'flood' 仍在写/排队
    expect(barrier).toHaveBeenCalledTimes(1)
    expect(result.current.getBacklog()).toBe(0)
    act(() => callbacks[1]?.())
    act(() => result.current.dispose())
  })
  it('resolves pending afterWrites barriers on dispose', () => {
    const write = vi.fn((_chunk: string, _done?: () => void) => {})
    const { result } = renderHook(() => useTerminalOutputScheduler({ write }))
    const barrier = vi.fn()
    act(() => result.current.push('chunk'))
    act(() => result.current.afterWrites(barrier))
    act(() => result.current.dispose())
    expect(barrier).toHaveBeenCalledTimes(1)
  })
})
