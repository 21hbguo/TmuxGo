import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalLayout } from './terminal-layout'
import { createTerminalResizeMask } from './terminal-resize-mask'

// 真实异步 rAF 队列：同步 mock 会让"跨帧"缺陷（pending 残留、样式修正擦除
// 键盘锚定、resize 饥饿）在测试里隐形，必须手动逐帧排空
const frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
const tick = (count = 1) => {
  for (let i = 0; i < count; i++) {
    const callbacks = [...frames.entries()]
    frames.clear()
    for (const [, cb] of callbacks) cb(0)
  }
}
interface HarnessOptions {
  shared?: boolean
  mobile?: boolean
}
function createHarness({ shared = false, mobile = false }: HarnessOptions = {}) {
  const container = document.createElement('div')
  container.innerHTML =
    '<div class="xterm"><div class="xterm-screen"><div class="xterm-rows"></div></div><div class="xterm-viewport"></div></div>'
  document.body.append(container)
  let width = 800
  let height = 480
  Object.defineProperties(container, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
  })
  const resizeCalls: Array<[number, number]> = []
  const terminal: any = {
    element: container.firstElementChild,
    cols: 80,
    rows: 24,
    options: { fontSize: 16, fontFamily: 'monospace' },
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: 10, height: 20 }, canvas: { width: 800, height: 480 } } },
        clear: vi.fn(),
      },
    },
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      resizeCalls.push([cols, rows])
    },
    refresh: vi.fn(),
    scrollToBottom: vi.fn(),
    clearTextureAtlas: vi.fn(),
    clearSelection: vi.fn(),
    buffer: { active: { baseY: 0, viewportY: 0 } },
  }
  const maskElement = document.createElement('div')
  const mask = createTerminalResizeMask({ mask: maskElement, getTerminal: () => terminal })
  const onResize = vi.fn()
  const revealMask = vi.fn((generation?: number) => mask.reveal(generation))
  const layout = createTerminalLayout({
    container,
    isMobile: mobile,
    getTerminal: () => terminal,
    isDisposed: () => false,
    preferencesRef: { current: { fontSize: 16, fontFamily: 'monospace', cursorBlink: true, terminalPadding: 0 } },
    attachExclusiveRef: { current: !shared },
    lastSizeRef: { current: { cols: 80, rows: 24 } },
    sharedSessionSizeRef: { current: null },
    onResizeRef: { current: onResize },
    controlCarryRef: { current: '' },
    mask,
    revealMask,
    getTerminalPerf: () => ({
      attachLatency: 0,
      outputBytes: 0,
      outputEvents: 0,
      outputBacklog: 0,
      layoutFitCount: 0,
      lastOutputAt: '',
    }),
    updateTerminalPerf: vi.fn(),
    notifyReady: vi.fn(),
    requestServerRedraw: vi.fn(),
  })
  return {
    layout,
    container,
    terminal,
    mask,
    maskElement,
    resizeCalls,
    onResize,
    revealMask,
    setSize(nextWidth: number, nextHeight: number) {
      width = nextWidth
      height = nextHeight
    },
  }
}

describe('terminal-layout', () => {
  beforeEach(() => {
    frames.clear()
    nextFrameId = 1
    // 必须先 fake timers 再 stub rAF：fake timers 会接管 requestAnimationFrame，
    // 顺序反了帧回调永远不会进手动队列
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrameId++
      frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.classList.remove('keyboard-open')
    document.body.replaceChildren()
  })

  it('clears the shared layout pending state once the rAF callback drains', () => {
    const h = createHarness({ shared: true })
    h.layout.scheduleLayoutSync()
    for (let i = 0; i < 8; i++) tick()
    expect(frames.size).toBe(0)
    expect(h.layout.isSyncPending()).toBe(false)
    h.layout.dispose()
  })
  it('clears the pending state even when the shared frame early-returns without canvas metrics', () => {
    const h = createHarness({ shared: true })
    delete h.terminal._core
    h.layout.scheduleLayoutSync()
    tick(4)
    expect(h.layout.isSyncPending()).toBe(false)
    h.layout.dispose()
  })
  it('makes throttled progress during a continuous drag and still converges on the final size', () => {
    const h = createHarness()
    h.layout.primeContainerSize()
    let now = 1_000
    vi.setSystemTime(now)
    for (let i = 0; i < 60; i++) {
      now += 16
      vi.setSystemTime(now)
      h.setSize(810 + i * 8, 480)
      h.layout.notifyObservedResize()
      tick()
    }
    // 拖动中途已有节流 fit 推进，而不是整段冻结
    expect(h.resizeCalls.length).toBeGreaterThan(0)
    // 停止后继续排空，最终收敛到最后观察到的尺寸
    for (let i = 0; i < 6; i++) tick()
    expect(h.resizeCalls.at(-1)).toEqual([Math.floor(1282 / 10), Math.floor(480 / 20)])
    h.layout.dispose()
  })
  it('reveals through the write barrier on a discrete single-step change', () => {
    const h = createHarness()
    h.layout.primeContainerSize()
    h.setSize(760, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    expect(h.revealMask).toHaveBeenCalled()
    h.layout.dispose()
  })
  it('keeps the mobile keyboard anchor across the renderer style-correction frame', () => {
    const h = createHarness({ mobile: true })
    document.body.classList.add('keyboard-open')
    h.setSize(800, 240)
    h.layout.syncExclusiveViewport()
    const screen = h.container.querySelector('.xterm-screen') as HTMLElement
    expect(screen.style.transform).toBe('translateY(-240px)')
    h.layout.scheduleRendererStyleCorrection()
    tick(2)
    expect(screen.style.transform).toBe('translateY(-240px)')
    h.layout.dispose()
  })
  it('keeps the keyboard clip after a width-change fit while the keyboard is open', () => {
    const h = createHarness({ mobile: true })
    h.setSize(800, 480)
    h.layout.primeContainerSize()
    document.body.classList.add('keyboard-open')
    h.setSize(600, 240)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    const screen = h.container.querySelector('.xterm-screen') as HTMLElement
    expect(screen.style.transform).toBe('translateY(-240px)')
    h.layout.dispose()
  })
})
