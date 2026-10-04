import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVncTouchAdapter,
  VNC_LONG_PRESS_MS,
  VNC_SCROLL_STEP_PX,
  VNC_SECOND_FINGER_MS,
  type VncTouchMode,
  type VncTouchPoint,
} from './vnc-touch-gestures'

// 画布 rect：left=100 top=50，400x300 → element 坐标 = client-(100,50)
const RECT = {
  left: 100,
  top: 50,
  right: 500,
  bottom: 350,
  width: 400,
  height: 300,
  x: 100,
  y: 50,
  toJSON: () => ({}),
} as DOMRect

const tp = (id: number, clientX: number, clientY: number): VncTouchPoint => ({ id, clientX, clientY })

const makeAdapter = (mode: VncTouchMode, cursor: { x: number; y: number } | null = { x: 200, y: 150 }) => {
  const sent: Array<[number, number, number]> = []
  const canvas = { getBoundingClientRect: () => RECT } as HTMLElement
  const adapter = createVncTouchAdapter({
    active: () => true,
    mode: () => mode,
    canvas: () => canvas,
    cursor: () => cursor,
    sendPointer: (x, y, mask) => sent.push([x, y, mask]),
  })
  return { adapter, sent }
}

describe('vnc-touch-gestures trackpad mode', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('converts single-finger movement into relative pointer deltas', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 300, 250)])
    adapter.handle('move', [tp(0, 350, 280)])
    adapter.handle('move', [tp(0, 360, 300)])
    // 光标从 hook 种子 (200,150) 起按 delta 累加，与触点绝对位置无关
    expect(sent).toEqual([
      [250, 180, 0],
      [260, 200, 0],
    ])
  })

  it('clicks at the virtual cursor position on tap, not at the touch point', () => {
    const { adapter, sent } = makeAdapter('trackpad', { x: 50, y: 60 })
    adapter.handle('start', [tp(0, 400, 300)])
    vi.advanceTimersByTime(100)
    adapter.handle('end', [])
    expect(sent).toEqual([
      [50, 60, 1],
      [50, 60, 0],
    ])
  })

  it('drags with the left button after a stationary long-press', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 300, 250)])
    vi.advanceTimersByTime(VNC_LONG_PRESS_MS + 10)
    adapter.handle('move', [tp(0, 340, 270)])
    adapter.handle('end', [])
    expect(sent).toEqual([
      [200, 150, 1],
      [240, 170, 1],
      [240, 170, 0],
    ])
  })

  it('does not arm the drag when the finger moved before the long-press', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 300, 250)])
    adapter.handle('move', [tp(0, 330, 250)])
    vi.advanceTimersByTime(VNC_LONG_PRESS_MS + 10)
    adapter.handle('end', [])
    // 只有一次普通移动，无按键
    expect(sent).toEqual([[230, 150, 0]])
  })

  it('sends a right click when both fingers lift in the same event', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 300, 200)])
    vi.advanceTimersByTime(60)
    adapter.handle('start', [tp(0, 300, 200), tp(1, 340, 220)])
    vi.advanceTimersByTime(100)
    // 两指同抬：同一个 end 事件里 touches 变空才构成双指短按
    adapter.handle('end', [])
    expect(sent).toEqual([
      [200, 150, 4],
      [200, 150, 0],
    ])
  })

  it('does not right-click when the two fingers lift one at a time', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 300, 200)])
    adapter.handle('start', [tp(0, 300, 200), tp(1, 340, 220)])
    vi.advanceTimersByTime(100)
    // 先抬一指：手势作废，剩余指不得再触发任何按键
    adapter.handle('end', [tp(1, 340, 220)])
    adapter.handle('end', [])
    expect(sent).toEqual([])
  })

  it('emits wheel steps on two-finger vertical movement', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 200, 150)])
    adapter.handle('start', [tp(0, 200, 150), tp(1, 200, 250)])
    vi.advanceTimersByTime(20)
    // 质心每移 50px 一步滚轮（拖内容约定：指下滚上 0x8 / 指上滚下 0x10）
    adapter.handle('move', [tp(0, 200, 210), tp(1, 200, 310)])
    adapter.handle('move', [tp(0, 200, 150), tp(1, 200, 250)])
    adapter.handle('move', [tp(0, 200, 120), tp(1, 200, 220)])
    expect(sent).toEqual([
      [200, 150, 8],
      [200, 150, 0],
      [200, 150, 0x10],
      [200, 150, 0],
    ])
  })

  it('ignores the whole gesture when a second finger lands too late', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 300, 200)])
    vi.advanceTimersByTime(VNC_SECOND_FINGER_MS + 50)
    adapter.handle('start', [tp(0, 300, 200), tp(1, 340, 220)])
    adapter.handle('end', [tp(1, 340, 220)])
    adapter.handle('end', [])
    expect(sent).toEqual([])
  })

  it('releases the held button on touchcancel mid-drag', () => {
    const { adapter, sent } = makeAdapter('trackpad')
    adapter.handle('start', [tp(0, 300, 250)])
    vi.advanceTimersByTime(VNC_LONG_PRESS_MS + 10)
    adapter.handle('cancel', [])
    expect(sent).toEqual([
      [200, 150, 1],
      [200, 150, 0],
    ])
  })
})

describe('vnc-touch-gestures touch mode', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('maps the touch point directly to desktop coordinates', () => {
    const { adapter, sent } = makeAdapter('touch', null)
    adapter.handle('start', [tp(0, 300, 250)])
    adapter.handle('move', [tp(0, 320, 270)])
    adapter.handle('end', [])
    // element 坐标 = client-(100,50)；落下即悬停到触点，随后拖动更新，长按才变点击
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual([
      [200, 200, 0],
      [220, 220, 0],
    ])
  })

  it('clicks at the touched point on a short tap', () => {
    const { adapter, sent } = makeAdapter('touch', null)
    adapter.handle('start', [tp(0, 300, 250)])
    vi.advanceTimersByTime(80)
    adapter.handle('end', [])
    expect(sent).toEqual([
      [200, 200, 0],
      [200, 200, 1],
      [200, 200, 0],
    ])
  })

  it('snaps a second tap to the first tap position for a double click', () => {
    const { adapter, sent } = makeAdapter('touch', null)
    adapter.handle('start', [tp(0, 210, 160)])
    vi.advanceTimersByTime(80)
    adapter.handle('end', [])
    vi.advanceTimersByTime(150)
    adapter.handle('start', [tp(0, 218, 166)])
    vi.advanceTimersByTime(80)
    adapter.handle('end', [])
    // 第二击落在吸附窗口内 → 复用第一击坐标 (110,110)，远端 OS 才能识别双击
    expect(sent).toEqual([
      [110, 110, 0],
      [110, 110, 1],
      [110, 110, 0],
      [118, 116, 0],
      [110, 110, 1],
      [110, 110, 0],
    ])
  })

  it('drags with the left button after a stationary long-press', () => {
    const { adapter, sent } = makeAdapter('touch', null)
    adapter.handle('start', [tp(0, 300, 250)])
    vi.advanceTimersByTime(VNC_LONG_PRESS_MS + 10)
    adapter.handle('move', [tp(0, 340, 270)])
    adapter.handle('end', [])
    expect(sent).toEqual([
      [200, 200, 0],
      [200, 200, 1],
      [240, 220, 1],
      [240, 220, 0],
    ])
  })

  it('right-clicks at the two-finger centroid', () => {
    const { adapter, sent } = makeAdapter('touch', null)
    adapter.handle('start', [tp(0, 200, 200)])
    adapter.handle('start', [tp(0, 200, 200), tp(1, 300, 200)])
    vi.advanceTimersByTime(100)
    adapter.handle('end', [])
    // 两指落下时各发了一次悬停移动（各触点 beginOne 只发第一指）
    expect(sent).toEqual([
      [100, 150, 0],
      [150, 150, 4],
      [150, 150, 0],
    ])
  })

  it('scrolls with two-finger vertical movement at the centroid', () => {
    const { adapter, sent } = makeAdapter('touch', null)
    adapter.handle('start', [tp(0, 200, 100)])
    adapter.handle('start', [tp(0, 200, 100), tp(1, 200, 300)])
    vi.advanceTimersByTime(20)
    adapter.handle('move', [tp(0, 200, 100 + VNC_SCROLL_STEP_PX), tp(1, 200, 300 + VNC_SCROLL_STEP_PX)])
    // 质心 (200,250)：element (100,200)；指下 = 滚轮上一步
    expect(sent).toEqual([
      [100, 50, 0],
      [100, 200, 8],
      [100, 200, 0],
    ])
  })

  it('clamps touch points into the canvas bounds', () => {
    const { adapter, sent } = makeAdapter('touch', null)
    adapter.handle('start', [tp(0, 50, 20)])
    vi.advanceTimersByTime(80)
    adapter.handle('end', [])
    expect(sent).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [0, 0, 0],
    ])
  })
})

describe('vnc-touch-gestures common', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does nothing while inactive', () => {
    const sent: Array<[number, number, number]> = []
    const adapter = createVncTouchAdapter({
      active: () => false,
      mode: () => 'trackpad',
      canvas: () => ({ getBoundingClientRect: () => RECT }) as HTMLElement,
      cursor: () => ({ x: 1, y: 1 }),
      sendPointer: (x, y, mask) => sent.push([x, y, mask]),
    })
    adapter.handle('start', [tp(0, 300, 200)])
    adapter.handle('end', [])
    expect(sent).toEqual([])
  })

  it('drops events when the canvas has no measurable rect', () => {
    const sent: Array<[number, number, number]> = []
    const adapter = createVncTouchAdapter({
      active: () => true,
      mode: () => 'touch',
      canvas: () => ({ getBoundingClientRect: () => ({ ...RECT, width: 0, height: 0 }) }) as HTMLElement,
      cursor: () => null,
      sendPointer: (x, y, mask) => sent.push([x, y, mask]),
    })
    adapter.handle('start', [tp(0, 300, 200)])
    adapter.handle('end', [])
    expect(sent).toEqual([])
  })
})
