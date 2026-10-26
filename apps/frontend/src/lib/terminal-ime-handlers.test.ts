import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalImeHandlers } from './terminal-ime-handlers'

function makeHarness() {
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  document.body.appendChild(helper)
  let composing = false
  const flushWriteBuffer = vi.fn()
  const syncHelperTextareaGeometry = vi.fn()
  const handlers = createTerminalImeHandlers({
    getHelperTextarea: () => helper,
    isComposing: () => composing,
    setComposing: (value) => {
      composing = value
    },
    flushWriteBuffer,
    syncHelperTextareaGeometry,
  })
  return {
    helper,
    handlers,
    flushWriteBuffer,
    syncHelperTextareaGeometry,
    isComposing: () => composing,
    cleanup: () => {
      handlers.dispose()
      helper.remove()
      document.body.classList.remove('ime-composing')
    },
  }
}

describe('createTerminalImeHandlers composition state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        cb(0)
        return 1
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.classList.remove('ime-composing')
  })

  it('marks and clears both shared signals on composition start/end', () => {
    const h = makeHarness()
    h.helper.focus()
    h.handlers.handleCompositionStart()
    expect(h.isComposing()).toBe(true)
    expect(document.body.classList.contains('ime-composing')).toBe(true)
    h.handlers.handleCompositionEnd()
    expect(h.isComposing()).toBe(false)
    expect(document.body.classList.contains('ime-composing')).toBe(false)
    h.cleanup()
  })

  it('flushes buffered output and resyncs geometry when composition ends', () => {
    const h = makeHarness()
    h.helper.focus()
    h.handlers.handleCompositionStart()
    h.handlers.handleCompositionEnd()
    expect(h.flushWriteBuffer).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(h.syncHelperTextareaGeometry).toHaveBeenCalled()
    h.cleanup()
  })

  it('heals a composition whose end/blur never arrived because focus left the helper textarea', () => {
    const h = makeHarness()
    h.helper.focus()
    h.handlers.handleCompositionStart()
    expect(document.body.classList.contains('ime-composing')).toBe(true)
    // 焦点元素被移出文档/被弹窗抢走时浏览器不派 blur，收尾事件整体丢失
    h.helper.blur()
    vi.advanceTimersByTime(400)
    expect(h.isComposing()).toBe(false)
    expect(document.body.classList.contains('ime-composing')).toBe(false)
    expect(h.flushWriteBuffer).toHaveBeenCalled()
    h.cleanup()
  })

  it('heals a composition that idles without any update while focus stays on the helper', () => {
    const h = makeHarness()
    h.helper.focus()
    h.handlers.handleCompositionStart()
    vi.advanceTimersByTime(5_000)
    expect(h.isComposing()).toBe(false)
    expect(document.body.classList.contains('ime-composing')).toBe(false)
    h.cleanup()
  })

  it('re-arms composition state when an update arrives after a spurious reset', () => {
    const h = makeHarness()
    h.helper.focus()
    h.handlers.handleCompositionStart()
    vi.advanceTimersByTime(5_000)
    expect(h.isComposing()).toBe(false)
    // 空闲误判后真正的组字还在继续：下一键的 update 必须把信号补回来，
    // 否则输出缓冲/聚焦闸门与实际组字脱节
    h.handlers.handleCompositionUpdate(new CompositionEvent('compositionupdate', { data: 'zho' }))
    expect(h.isComposing()).toBe(true)
    expect(document.body.classList.contains('ime-composing')).toBe(true)
    h.cleanup()
  })

  it('resets on blur only when this instance was composing', () => {
    const h = makeHarness()
    h.handlers.handleBlur()
    expect(h.isComposing()).toBe(false)
    // 别处（另一实例/移动端）加的共享信号不该被本地 blur 顺手清掉
    document.body.classList.add('ime-composing')
    h.handlers.handleBlur()
    expect(document.body.classList.contains('ime-composing')).toBe(true)
    h.cleanup()
  })

  it('stops the health watchdog once disposed', () => {
    const h = makeHarness()
    h.helper.focus()
    h.handlers.handleCompositionStart()
    h.handlers.dispose()
    expect(h.handlers.isComposingWatchActive()).toBe(false)
    h.helper.remove()
    document.body.classList.remove('ime-composing')
  })
})
