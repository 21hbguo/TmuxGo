import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalLayout } from './terminal-layout'
import { createTerminalResizeMask } from './terminal-resize-mask'
import { createTerminalSizeState } from './terminal-size-state'

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
  followedSize?: { cols: number; rows: number } | null
}
function createHarness({ shared = false, mobile = false, followedSize }: HarnessOptions = {}) {
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
  const sizeState = createTerminalSizeState({
    attachExclusiveRef: { current: !shared },
    hasResizeConsumer: () => true,
    lastSize: { cols: 80, rows: 24 },
    // shared 路径读 sharedSize：不置初值会在 syncSharedLayout 入口 return，测试空跑
    sharedSize: shared ? { cols: 80, rows: 24 } : null,
    followedSize: followedSize ?? null,
  })
  const layout = createTerminalLayout({
    container,
    isMobile: mobile,
    getTerminal: () => terminal,
    isDisposed: () => false,
    preferencesRef: { current: { fontSize: 16, fontFamily: 'monospace', cursorBlink: true, terminalPadding: 0 } },
    size: sizeState,
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
    sizeState,
    // 模拟服务端 resized/localOnly 确认到达（runtime handleResized 的尺寸匹配清零）
    ackResize(cols: number, rows: number) {
      sizeState.noteResized(cols, rows)
    },
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
  it('keeps the mask until the remote ACK arrives on a discrete single-step change', () => {
    const h = createHarness()
    h.layout.primeContainerSize()
    h.setSize(760, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    // 行列变了（76x24）：已发 resize，ACK 未回前不揭——否则露出本地重排、远端未收敛的中间帧
    expect(h.onResize).toHaveBeenCalledWith(76, 24)
    expect(h.revealMask).not.toHaveBeenCalled()
    expect(h.mask.isPending()).toBe(true)
    // ACK 到达清在途后，下一次布局帧本地揭开（真实路径是 handleResized 的写屏障；
    // 用 4px 像素抖动触发一次观察，行列不变、无在途 → 揭开）
    h.ackResize(76, 24)
    h.setSize(764, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    expect(h.revealMask).toHaveBeenCalled()
    h.layout.dispose()
    h.mask.dispose()
  })
  it('reveals after a two-step pixel resize which never changes terminal cells', () => {
    const h = createHarness()
    vi.setSystemTime(1000)
    h.layout.scheduleLayoutSync(0, true)
    tick(8)
    h.layout.primeContainerSize()
    // 800->804->808px、单元格 10px：行列始终 80x24，没有任何 resize 发出，
    // 不存在在途 ACK——不能按 burst 次数猜而罩到 900ms failsafe
    h.setSize(804, 480)
    h.layout.notifyObservedResize()
    vi.setSystemTime(1016)
    h.setSize(808, 480)
    h.layout.notifyObservedResize()
    tick(10)
    expect(h.onResize).not.toHaveBeenCalled()
    expect(h.mask.isPending()).toBe(false)
    h.layout.dispose()
    h.mask.dispose()
  })
  it('reveals pixel-only changes again after the previous resize ACK completed', () => {
    const h = createHarness()
    vi.setSystemTime(1000)
    h.layout.primeContainerSize()
    // 先发一次真实行列变化并等到 ACK 清在途
    h.setSize(900, 480)
    h.layout.notifyObservedResize()
    tick(8)
    expect(h.onResize).toHaveBeenCalledWith(90, 24)
    expect(h.mask.isPending()).toBe(true)
    h.ackResize(90, 24)
    // ACK 完成后同格子内的像素变化再次 show，必须及时揭开而不是罩到 failsafe
    vi.setSystemTime(1400)
    h.setSize(904, 480)
    h.layout.notifyObservedResize()
    vi.setSystemTime(1416)
    h.setSize(908, 480)
    h.layout.notifyObservedResize()
    tick(10)
    expect(h.mask.isPending()).toBe(false)
    h.layout.dispose()
    h.mask.dispose()
  })
  it('clears a stale followed window size once the exclusive client sees a real container change', () => {
    // owner 收到自身主张的 window-size 回声会进入跟随态；真实容器变化必须解除
    // 跟随重新独占 fit，否则网格被钉在推送尺寸上、只能缩放字体铺满容器
    const h = createHarness({ followedSize: { cols: 137, rows: 23 } })
    h.layout.primeContainerSize()
    vi.setSystemTime(1000)
    h.setSize(1000, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    expect(h.sizeState.followedSize).toBe(null)
    expect(h.resizeCalls.at(-1)).toEqual([100, 24])
    expect(h.onResize).toHaveBeenCalledWith(100, 24)
    h.layout.dispose()
  })
  it('keeps the followed window size for a shared client across container changes', () => {
    // 非独占端不得借容器变化清跟随重新主张：那会让旁观端用本机尺寸抢 window
    const h = createHarness({ shared: true, followedSize: { cols: 137, rows: 23 } })
    h.layout.primeContainerSize()
    vi.setSystemTime(1000)
    h.setSize(1000, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    expect(h.sizeState.followedSize).toEqual({ cols: 137, rows: 23 })
    expect(h.onResize).not.toHaveBeenCalled()
    h.layout.dispose()
  })
  it('aligns a demoted owner to the pushed window size through the shared layout path', () => {
    // window-size 仲裁回声：owner 被降级跟随，布局必须走共享路径对齐推送尺寸，
    // 不得跑独占 fit 用本机容器尺寸把 window 抢回去
    const h = createHarness()
    h.layout.primeContainerSize()
    vi.setSystemTime(1000)
    h.sizeState.noteWindowSize(120, 36)
    h.layout.scheduleLayoutSync(0, true)
    for (let i = 0; i < 8; i++) tick()
    expect(h.resizeCalls.at(-1)).toEqual([120, 36])
    expect(h.sizeState.followedSize).toEqual({ cols: 120, rows: 36 })
    h.layout.dispose()
  })
  it('keeps the mask pending when only a stale mismatched ACK has arrived', () => {
    // 旧尺寸 ACK（A->B->A 的旧 B）不确认末次在途：遮罩继续等正确 ACK
    const h = createHarness()
    h.layout.primeContainerSize()
    vi.setSystemTime(1000)
    h.setSize(900, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    expect(h.onResize).toHaveBeenCalledWith(90, 24)
    expect(h.sizeState.hasPending()).toBe(true)
    h.ackResize(80, 24)
    vi.setSystemTime(1200)
    h.setSize(904, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    expect(h.sizeState.hasPending()).toBe(true)
    expect(h.mask.isPending()).toBe(true)
    h.ackResize(90, 24)
    h.setSize(908, 480)
    h.layout.notifyObservedResize()
    for (let i = 0; i < 8; i++) tick()
    expect(h.sizeState.hasPending()).toBe(false)
    h.layout.dispose()
    h.mask.dispose()
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
  it('does not keep the mask pending during a real window-resize drag (window event + RO)', () => {
    const h = createHarness()
    h.layout.primeContainerSize()
    vi.setSystemTime(1000)
    // 真实浏览器拖动：同一尺寸变化同时触发 window resize 与 RO——
    // window handler 必须走共享的拖动判定，不能每次无条件 show 把遮罩焊死
    for (let i = 0; i < 60; i++) {
      vi.setSystemTime(1000 + i * 16)
      h.setSize(810 + i * 4, 480)
      h.layout.notifyWindowResize()
      h.layout.notifyObservedResize()
      tick()
    }
    expect(h.resizeCalls.length).toBeGreaterThan(0)
    expect(h.mask.isPending()).toBe(false)
    h.layout.dispose()
    h.mask.dispose()
  })
  it('ignores a window resize event that did not change the container size', () => {
    const h = createHarness()
    h.layout.primeContainerSize()
    vi.setSystemTime(1000)
    h.layout.notifyWindowResize()
    h.layout.notifyWindowResize()
    tick(4)
    expect(h.resizeCalls).toHaveLength(0)
    expect(h.mask.isPending()).toBe(false)
    h.layout.dispose()
    h.mask.dispose()
  })
})
