import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { RESIZE_BACKPRESSURE_GRACE_MS, resetResizeBackpressureGrace } from '@/lib/resize-grace'
import { useTerminalOutputScheduler } from './useTerminalOutputScheduler'
describe('useTerminalOutputScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetResizeBackpressureGrace()
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
    expect(onBackpressure).toHaveBeenLastCalledWith(
      'high',
      70000,
      expect.objectContaining({ backlog: 70000, inFlight: 5 }),
    )
    act(() => complete?.())
    expect(onBackpressure).toHaveBeenLastCalledWith('high', 70000, expect.objectContaining({ backlog: 70000 }))
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
  it('yields the event loop between writes once continuous work exceeds the budget', () => {
    // 主线程时间预算：backlog 排空前连续写超过 WRITE_YIELD_BUDGET_MS 后，
    // 下一笔写必须经 setTimeout(0) 让出事件循环（输入/绘制可插入），
    // 而不是一直在 write 回调里同步链式续写拼出 >50ms 长任务
    const callbacks: Array<(() => void) | undefined> = []
    const write = vi.fn((_chunk: string, done?: () => void) => {
      callbacks.push(done)
    })
    const { result } = renderHook(() => useTerminalOutputScheduler({ write, frameBudget: 100 }))
    act(() => result.current.push('a'))
    act(() => result.current.push('x'.repeat(250)))
    act(() => callbacks[0]?.())
    expect(write.mock.calls.length).toBe(2)
    act(() => callbacks[1]?.())
    expect(write.mock.calls.length).toBe(3)
    // 推进时钟超过 12ms 连续工时预算后完成写：下一笔须经 0ms timer 让出
    act(() => vi.advanceTimersByTime(20))
    act(() => callbacks[2]?.())
    expect(write.mock.calls.length).toBe(3)
    act(() => vi.advanceTimersByTime(1))
    expect(write.mock.calls.length).toBe(4)
    act(() => result.current.dispose())
  })
  it('suppresses high backpressure during the resize grace window without consuming the edge', () => {
    // resize 突发（缓冲即最终帧）不应上报 high；但边沿不得被消费——
    // 窗口过后 backlog 仍超阈值时下一笔 push 必须自然补报
    const nowSpy = vi.spyOn(performance, 'now')
    nowSpy.mockReturnValue(1000)
    // write 永不回调 → 首笔在途，后续 push 全部进 backlog
    const write = vi.fn((_chunk: string, _done?: () => void) => {})
    const onBackpressure = vi.fn()
    const onBackpressureSuppressed = vi.fn()
    const { result } = renderHook(() => useTerminalOutputScheduler({ write, onBackpressure, onBackpressureSuppressed }))
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' }))
    act(() => result.current.push('a'))
    act(() => result.current.push('x'.repeat(70000)))
    expect(onBackpressure).not.toHaveBeenCalledWith('high', expect.anything(), expect.anything())
    expect(onBackpressureSuppressed).toHaveBeenCalledTimes(1)
    // 窗口内再次积压也只通知一次
    act(() => result.current.push('y'.repeat(70000)))
    expect(onBackpressureSuppressed).toHaveBeenCalledTimes(1)
    // 窗口过后积压仍在 → 补报 high（证明边沿没被吞掉）
    nowSpy.mockReturnValue(1000 + RESIZE_BACKPRESSURE_GRACE_MS + 10)
    act(() => result.current.push('z'))
    expect(onBackpressure).toHaveBeenCalledWith('high', expect.any(Number), expect.anything())
    nowSpy.mockRestore()
    act(() => result.current.dispose())
  })
  it('reports high backpressure normally outside the grace window', () => {
    const write = vi.fn((_chunk: string, done?: () => void) => done?.())
    const onBackpressure = vi.fn()
    const onBackpressureSuppressed = vi.fn()
    const { result } = renderHook(() => useTerminalOutputScheduler({ write, onBackpressure, onBackpressureSuppressed }))
    act(() => emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' }))
    act(() => result.current.push('x'.repeat(70000)))
    expect(onBackpressure).toHaveBeenCalledWith('high', expect.any(Number), expect.anything())
    expect(onBackpressureSuppressed).not.toHaveBeenCalled()
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
