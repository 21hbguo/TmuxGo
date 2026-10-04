import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStreamPause } from './useStreamPause'

const setHidden = (v: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, value: v })
const fireVisibility = () => act(() => void document.dispatchEvent(new Event('visibilitychange')))

const setup = (initialPaused = false) => {
  const transport = { open: false }
  const sent: boolean[] = []
  const onVisible = vi.fn()
  const view = renderHook(
    ({ paused }) =>
      useStreamPause({
        paused,
        isOpen: () => transport.open,
        send: (p) => sent.push(p),
        onVisible,
      }),
    { initialProps: { paused: initialPaused } },
  )
  return { transport, sent, onVisible, ...view }
}

describe('useStreamPause', () => {
  afterEach(() => setHidden(false))

  it('sends pause/resume as the external pause source flips while open', () => {
    const { transport, sent, rerender } = setup()
    transport.open = true
    rerender({ paused: true })
    expect(sent).toEqual([true])
    rerender({ paused: false })
    expect(sent).toEqual([true, false])
  })

  it('pauses on document.hidden and resumes only when visible again', () => {
    const { transport, sent, rerender } = setup()
    transport.open = true
    rerender({ paused: false }) // 触发一次 effect 让 sent 同步为已下发的非暂停态
    setHidden(true)
    fireVisibility()
    expect(sent).toEqual([true])
    setHidden(false)
    fireVisibility()
    expect(sent).toEqual([true, false])
  })

  it('keeps the paused target until both sources are clear', () => {
    const { transport, sent, rerender, result } = setup(true)
    // 挂载即暂停且传输未开：只记不发；notifyOpen 补发目标态
    transport.open = true
    act(() => result.current.notifyOpen())
    expect(sent).toEqual([true])
    // 面板仍最小化时恢复可见不得 resume
    setHidden(true)
    fireVisibility()
    setHidden(false)
    fireVisibility()
    expect(sent).toEqual([true])
    rerender({ paused: false })
    expect(sent).toEqual([true, false])
  })

  it('records the target while closed and pushes it once on notifyOpen', () => {
    const { transport, sent, rerender, result } = setup()
    setHidden(true)
    fireVisibility()
    rerender({ paused: true })
    expect(sent).toEqual([])
    transport.open = true
    act(() => result.current.notifyOpen())
    expect(sent).toEqual([true])
  })

  it('sends nothing on open when the target is unpaused (fresh client default)', () => {
    const { transport, sent, result } = setup()
    transport.open = true
    act(() => result.current.notifyOpen())
    expect(sent).toEqual([])
  })

  it('re-sends the paused target on a new transport', () => {
    const { transport, sent, rerender, result } = setup()
    transport.open = true
    rerender({ paused: true })
    expect(sent).toEqual([true])
    // 传输层换新（服务端 client 重置非暂停）：notifyOpen 后须重发暂停
    transport.open = false
    transport.open = true
    act(() => result.current.notifyOpen())
    expect(sent).toEqual([true, true])
  })

  it('does not resume when the external source clears while the document stays hidden', () => {
    const { transport, sent, rerender } = setup()
    transport.open = true
    setHidden(true)
    fireVisibility()
    rerender({ paused: true })
    expect(sent).toEqual([true])
    // hidden 仍是真：外部源解除只改单一来源，目标态依旧暂停，不得发 resume
    rerender({ paused: false })
    expect(sent).toEqual([true])
    setHidden(false)
    fireVisibility()
    expect(sent).toEqual([true, false])
  })

  it('dedupes repeated triggers of the same state', () => {
    const { transport, sent, rerender } = setup()
    transport.open = true
    rerender({ paused: false })
    setHidden(true)
    fireVisibility()
    fireVisibility()
    expect(sent).toEqual([true])
    setHidden(false)
    fireVisibility()
    fireVisibility()
    expect(sent).toEqual([true, false])
  })

  it('invokes onVisible only when the document becomes visible', () => {
    const { transport, onVisible } = setup()
    transport.open = true
    setHidden(true)
    fireVisibility()
    expect(onVisible).not.toHaveBeenCalled()
    setHidden(false)
    fireVisibility()
    expect(onVisible).toHaveBeenCalledTimes(1)
  })
})
