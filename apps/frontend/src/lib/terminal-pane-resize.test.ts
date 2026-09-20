import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalPaneResizeController } from './terminal-pane-resize'
import { STREAM_EVENT, subscribeStreamEvent } from './stream-events'

const makeScreen = () => {
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0 }) as DOMRect
  return screen
}

const setup = (overrides: Record<string, any> = {}) => {
  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0 }) as DOMRect
  document.body.appendChild(container)
  const screen = makeScreen()
  const targetFor =
    overrides.targetFor ??
    ((_e: MouseEvent) => ({
      paneId: 'local:%1',
      axis: 'x' as const,
      startCell: 50,
      startSize: 60,
      paneStart: 0,
      crossStart: 0,
      crossSize: 40,
    }))
  const options = {
    container,
    guide: document.createElement('div'),
    getTerminal: () => ({ element: { querySelector: () => screen }, cols: 100, rows: 40 }),
    getMouseCell: (e: MouseEvent) => ({ x: Math.round(e.clientX / 10), y: Math.round(e.clientY / 15) }),
    getPaneResizeTarget: targetFor,
    resizePane: vi.fn(() => Promise.resolve()),
    loadSessionSnapshot: vi.fn(() => Promise.resolve()),
    clearSelection: vi.fn(),
    clearCopySelectionTimer: vi.fn(),
    clearPointerSync: vi.fn(),
    dispatchLayoutChange: vi.fn(),
    ...overrides.options,
  }
  const controller = createTerminalPaneResizeController(options)
  controller.attach()
  const gestures: string[] = []
  const unsub = subscribeStreamEvent(STREAM_EVENT.resizeGesture, (d: any) => gestures.push(d?.phase))
  return { container, options, controller, gestures, unsub }
}

const down = (container: HTMLElement, x = 620) =>
  container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: 300 }))
const move = (x: number) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 300 }))
const up = () => window.dispatchEvent(new MouseEvent('mouseup'))

describe('terminal-pane-resize commit coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
  })

  it('merges five rapid drags on the same divider into a single resizePane with the final size', () => {
    const { container, options, unsub } = setup()
    for (let i = 0; i < 5; i++) {
      down(container)
      move(640 + i * 10) // cell x 64+i → size 60+(14+i)
      up()
      vi.advanceTimersByTime(20)
    }
    vi.advanceTimersByTime(100)
    expect(options.resizePane).toHaveBeenCalledTimes(1)
    expect(options.resizePane).toHaveBeenLastCalledWith('local:%1', { cols: 60 + 18 })
    unsub()
  })

  it('commits once per drag when drags are separated beyond the merge window', () => {
    const { container, options, unsub } = setup()
    down(container)
    move(650)
    up()
    vi.advanceTimersByTime(200)
    down(container)
    move(660)
    up()
    vi.advanceTimersByTime(200)
    expect(options.resizePane).toHaveBeenCalledTimes(2)
    expect(options.resizePane).toHaveBeenNthCalledWith(1, 'local:%1', { cols: 75 })
    expect(options.resizePane).toHaveBeenNthCalledWith(2, 'local:%1', { cols: 76 })
    unsub()
  })

  it('keeps the queued commit when the next same-divider drag ends as a no-op', () => {
    const { container, options, unsub } = setup()
    down(container)
    move(650) // → size 75，入队 pending
    up()
    vi.advanceTimersByTime(20)
    // 第二次手势只是按下又松开（无移动）：pendingSize===sentSize → no-op
    down(container)
    up()
    vi.advanceTimersByTime(200)
    // 第一笔有效目标不得因 no-op 手势丢失
    expect(options.resizePane).toHaveBeenCalledTimes(1)
    expect(options.resizePane).toHaveBeenLastCalledWith('local:%1', { cols: 75 })
    unsub()
  })

  it('does not let a paused pending fire mid-drag and replaces it with the new final size', () => {
    const { container, options, unsub } = setup()
    down(container)
    move(650) // A=75 入队
    up()
    vi.advanceTimersByTime(50) // 距合并窗到期还剩 30ms
    down(container) // 暂停 A 的计时
    vi.advanceTimersByTime(100) // 拖拽中经过原到期点——不得中途发出 A
    expect(options.resizePane).toHaveBeenCalledTimes(0)
    move(660) // B=76
    up()
    vi.advanceTimersByTime(200)
    expect(options.resizePane).toHaveBeenCalledTimes(1)
    expect(options.resizePane).toHaveBeenLastCalledWith('local:%1', { cols: 76 })
    unsub()
  })

  it('keeps per-pane pending commits on independent timers', () => {
    let pane = 'local:%1'
    const { container, options, unsub } = setup({
      targetFor: () => ({
        paneId: pane,
        axis: 'x' as const,
        startCell: 50,
        startSize: 60,
        paneStart: 0,
        crossStart: 0,
        crossSize: 40,
      }),
    })
    down(container)
    move(640) // %1 → 74
    up()
    vi.advanceTimersByTime(30) // %1 还剩 50ms
    pane = 'local:%2'
    down(container)
    move(650) // %2 → 75
    up()
    // %1 的窗口不被 %2 的入队强制提前 flush，也不被覆盖——各自 80ms
    vi.advanceTimersByTime(60) // t≈90：%1 已发，%2 还差 ~10ms
    expect(options.resizePane).toHaveBeenCalledTimes(1)
    expect(options.resizePane).toHaveBeenNthCalledWith(1, 'local:%1', { cols: 74 })
    vi.advanceTimersByTime(40)
    expect(options.resizePane).toHaveBeenCalledTimes(2)
    expect(options.resizePane).toHaveBeenNthCalledWith(2, 'local:%2', { cols: 75 })
    unsub()
  })

  it('does not drop a pending commit for a different pane when another drag queues', () => {
    let pane = 'local:%1'
    const { container, options, unsub } = setup({
      targetFor: () => ({
        paneId: pane,
        axis: 'x' as const,
        startCell: 50,
        startSize: 60,
        paneStart: 0,
        crossStart: 0,
        crossSize: 40,
      }),
    })
    down(container)
    move(640)
    up()
    pane = 'local:%2'
    down(container)
    move(650)
    up()
    vi.advanceTimersByTime(100)
    // 不同 pane 的 pending 不被覆盖：%1 立即补发，%2 走自己的窗口
    expect(options.resizePane).toHaveBeenCalledTimes(2)
    expect(options.resizePane).toHaveBeenNthCalledWith(1, 'local:%1', { cols: 74 })
    expect(options.resizePane).toHaveBeenNthCalledWith(2, 'local:%2', { cols: 75 })
    unsub()
  })

  it('flushes the pending commit on dispose instead of delivering it late', () => {
    const { container, options, controller, unsub } = setup()
    down(container)
    move(650)
    up()
    controller.dispose()
    expect(options.resizePane).toHaveBeenCalledTimes(1)
    expect(options.resizePane).toHaveBeenLastCalledWith('local:%1', { cols: 75 })
    vi.advanceTimersByTime(200)
    expect(options.resizePane).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('emits gesture end on blur mid-drag and never leaves the gesture unsettled', () => {
    const { container, gestures, unsub } = setup()
    down(container)
    move(650)
    window.dispatchEvent(new Event('blur'))
    expect(gestures).toEqual(['start', 'end'])
    unsub()
  })

  it('emits gesture end on dispose mid-drag', () => {
    const { container, gestures, controller, unsub } = setup()
    down(container)
    move(650)
    controller.dispose()
    expect(gestures).toEqual(['start', 'end'])
    unsub()
  })
})
