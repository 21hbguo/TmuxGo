import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTerminalTouchScroll } from './useTerminalTouchScroll'

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    isMobile: true,
    onScroll: vi.fn(),
    onTap: vi.fn(),
    onTouchMovedChange: vi.fn(),
    onSwipeLeft: vi.fn(),
    onSwipeRight: vi.fn(),
    onTwoFingerDoubleTap: vi.fn(),
    ...overrides,
  }
}

function touchEvent(touches: Array<{ clientX: number; clientY: number; identifier: number }>, changedSame = true) {
  return {
    touches,
    changedTouches: changedSame ? touches : [],
    preventDefault: vi.fn(),
  } as unknown as TouchEvent
}

describe('useTerminalTouchScroll', () => {
  it('keeps returned handlers referentially stable when callback props change identity', () => {
    const first = makeProps()
    const { result, rerender } = renderHook((props) => useTerminalTouchScroll(props), { initialProps: first })
    const initial = result.current
    rerender(makeProps())
    rerender(makeProps())
    expect(result.current).toBe(initial)
    expect(result.current.handleTouchStart).toBe(initial.handleTouchStart)
    expect(result.current.handleTouchEnd).toBe(initial.handleTouchEnd)
  })

  it('fires onSwipeLeft on a horizontal single-finger swipe', () => {
    const props = makeProps()
    const { result } = renderHook((p) => useTerminalTouchScroll(p), { initialProps: props })
    const t = result.current
    t.handleTouchStart(touchEvent([{ clientX: 300, clientY: 200, identifier: 1 }]))
    t.handleTouchMove(touchEvent([{ clientX: 200, clientY: 205, identifier: 1 }]))
    t.handleTouchEnd({
      touches: [],
      changedTouches: [{ clientX: 200, clientY: 205, identifier: 1 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent)
    expect(props.onSwipeLeft).toHaveBeenCalledTimes(1)
    expect(props.onSwipeRight).not.toHaveBeenCalled()
  })

  it('does not fire swipe when a second finger joined the gesture', () => {
    const props = makeProps()
    const { result } = renderHook((p) => useTerminalTouchScroll(p), { initialProps: props })
    const t = result.current
    t.handleTouchStart(
      touchEvent([
        { clientX: 300, clientY: 200, identifier: 1 },
        { clientX: 320, clientY: 210, identifier: 2 },
      ]),
    )
    t.handleTouchEnd({
      touches: [],
      changedTouches: [{ clientX: 200, clientY: 60, identifier: 1 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent)
    expect(props.onSwipeLeft).not.toHaveBeenCalled()
    expect(props.onSwipeRight).not.toHaveBeenCalled()
  })

  it('ignores horizontal gestures whose vertical travel dominates', () => {
    const props = makeProps()
    const { result } = renderHook((p) => useTerminalTouchScroll(p), { initialProps: props })
    const t = result.current
    t.handleTouchStart(touchEvent([{ clientX: 300, clientY: 100, identifier: 1 }]))
    t.handleTouchMove(touchEvent([{ clientX: 240, clientY: 100, identifier: 1 }]))
    t.handleTouchEnd({
      touches: [],
      changedTouches: [{ clientX: 230, clientY: 175, identifier: 1 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent)
    expect(props.onSwipeLeft).not.toHaveBeenCalled()
    expect(props.onSwipeRight).not.toHaveBeenCalled()
  })
})
