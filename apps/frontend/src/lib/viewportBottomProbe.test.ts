import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createViewportBottomProbeRunner,
  probeBottomEdge,
  ViewportBottomProbeGate,
  type BottomProbeInput,
} from './viewportBottomProbe'

const baseInput = (over: Partial<BottomProbeInput> = {}): BottomProbeInput => ({
  mobile: true,
  keyboardOpen: true,
  now: 1000,
  vv: { height: 336.2, offsetTop: 0 },
  innerHeight: 658,
  ...over,
})

function stubElementFromPoint(hits: (y: number) => HTMLElement | null) {
  const fn = vi.fn((_x: number, y: number) => hits(y))
  Object.defineProperty(document, 'elementFromPoint', { value: fn, configurable: true, writable: true })
  return fn
}

function elementAt(tag = 'DIV'): HTMLElement {
  return document.createElement(tag)
}

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint')
  window.localStorage.removeItem('tmuxgo-debug-mobile')
  delete (window as typeof window & { __tmuxgoMobileDiagnostics?: unknown }).__tmuxgoMobileDiagnostics
  vi.restoreAllMocks()
})

describe('probeBottomEdge — elementFromPoint', () => {
  it('derives the visible bottom from the furthest element hit below vv.bottom', () => {
    stubElementFromPoint((y) => (y <= 470 ? elementAt() : null))
    const sample = probeBottomEdge(baseInput())
    // 起点 vvBottom+8=344.2，步长 24：344, 368, 392, 416, 440, 464, 488, 512
    expect(sample.probeMethod).toBe('elementFromPoint')
    expect(sample.probeVisibleBottom).toBe(464)
    expect(sample.vvBottom).toBe(336.2)
    expect(sample.vvVsProbeDelta).toBeCloseTo(127.8, 1)
    expect(sample.probeHits).toBe('344:E;368:E;392:E;416:E;440:E;464:E;488:N;512:N')
    expect(sample.probeCanvasBottom).toBe(464)
    expect(sample.innerHeight).toBe(658)
    expect(sample.vvHeight).toBe(336.2)
  })

  it('keeps root hits out of probeVisibleBottom but counts them as canvas', () => {
    stubElementFromPoint((y) => (y === 344 ? document.body : y === 368 ? document.documentElement : null))
    const sample = probeBottomEdge(baseInput())
    expect(sample.probeHits).toBe('344:B;368:B;392:N;416:N;440:N;464:N;488:N;512:N')
    // 根节点可能只是「画布可见但空」，不冒充应用内容
    expect(sample.probeVisibleBottom).toBe(336.2)
    expect(sample.vvVsProbeDelta).toBe(0)
    // …但 canvas 语义把这段已绘制区域照出来
    expect(sample.probeCanvasBottom).toBe(368)
  })

  it('separates content bottom from canvas bottom in the dead-band shape', () => {
    // 应用内容到 400 为止，其下全是 html/body 画布：Edge 死区的真实形态
    stubElementFromPoint((y) => (y <= 400 ? elementAt() : document.body))
    const sample = probeBottomEdge(baseInput())
    expect(sample.probeHits).toBe('344:E;368:E;392:E;416:B;440:B;464:B;488:B;512:B')
    expect(sample.probeVisibleBottom).toBe(392)
    expect(sample.probeCanvasBottom).toBe(512)
    expect(sample.vvVsProbeDelta).toBeCloseTo(55.8, 1)
  })

  it('reports the Edge dead band as a positive vv-vs-probe delta', () => {
    // Field values: innerHeight 658, vv 336.2, paint visible to ~474.
    stubElementFromPoint((y) => (y <= 474 ? elementAt() : null))
    const sample = probeBottomEdge(baseInput(), { maxPoints: 12 })
    expect(sample.probeVisibleBottom).toBeGreaterThanOrEqual(464)
    expect(sample.vvVsProbeDelta).toBeGreaterThan(120)
  })

  it('caps the probe points and stops at innerHeight - edge', () => {
    const fn = stubElementFromPoint(() => elementAt())
    const sample = probeBottomEdge(baseInput())
    expect(fn.mock.calls.length).toBeLessThanOrEqual(8)
    for (const [, y] of fn.mock.calls) expect(y).toBeLessThanOrEqual(658 - 8)
    expect(sample.probeVisibleBottom).toBe(512)
  })

  it('records a missing visual viewport as unavailable rather than a guess', () => {
    stubElementFromPoint(() => elementAt())
    const sample = probeBottomEdge(baseInput({ vv: null }))
    expect(sample.probeMethod).toBe('none')
    expect(sample.probeVisibleBottom).toBeNull()
    expect(sample.probeCanvasBottom).toBeNull()
    expect(sample.vvBottom).toBeNull()
    expect(sample.vvVsProbeDelta).toBeNull()
  })

  it('reports an absent hit-test API as unavailable', () => {
    const sample = probeBottomEdge(baseInput())
    expect(sample.probeMethod).toBe('none')
    expect(sample.probeVisibleBottom).toBeNull()
    expect(sample.probeCanvasBottom).toBeNull()
  })

  it('aborts over budget and says so', () => {
    stubElementFromPoint(() => elementAt())
    let t = 0
    const sample = probeBottomEdge(baseInput(), { clock: () => (t += 1) })
    expect(sample.probeMethod).toBe('budget')
    expect(sample.probeVisibleBottom).toBeNull()
    expect(sample.probeCanvasBottom).toBeNull()
    expect(sample.vvVsProbeDelta).toBeNull()
    expect(sample.probeCostMs).toBeGreaterThan(2)
    // Partial hit list is kept so the attempt is auditable.
    expect(sample.probeHits.length).toBeGreaterThan(0)
    expect(sample.probeHits.split(';').length).toBeLessThanOrEqual(8)
  })

  it('passes raw virtual-keyboard geometry through without touching overlaysContent', () => {
    stubElementFromPoint(() => elementAt())
    const vk = { overlaysContent: false, boundingRect: { x: 0, y: 500.4, width: 390, height: 300.6 } }
    const sample = probeBottomEdge(baseInput({ getVirtualKeyboard: () => vk }))
    expect(sample.vkRectHeight).toBe(300.6)
    expect(sample.vkRectTop).toBe(500.4)
    expect(vk.overlaysContent).toBe(false)
  })

  it('leaves vk fields null when the API is absent', () => {
    stubElementFromPoint(() => elementAt())
    const sample = probeBottomEdge(baseInput({ getVirtualKeyboard: () => undefined }))
    expect(sample.vkRectHeight).toBeNull()
    expect(sample.vkRectTop).toBeNull()
  })
})

describe('ViewportBottomProbeGate', () => {
  const gate = () => new ViewportBottomProbeGate(2, 5)

  it('never runs on desktop', () => {
    const g = gate()
    for (let i = 0; i < 10; i += 1)
      expect(g.shouldRun({ mobile: false, keyboardOpen: true, vvHeight: 336 })).toBe(false)
  })

  it('always runs while the keyboard is open', () => {
    const g = gate()
    expect(g.shouldRun({ mobile: true, keyboardOpen: true, vvHeight: 336 })).toBe(true)
    expect(g.shouldRun({ mobile: true, keyboardOpen: true, vvHeight: 336 })).toBe(true)
  })

  it('stays hot for a few ticks after the visual viewport changes, then slows down', () => {
    const g = gate()
    // First tick establishes the baseline (counts as a change → hot).
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 658 })).toBe(true)
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 658 })).toBe(true)
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 658 })).toBe(true)
    // Hot window (2 ticks) is over: skipped on steady closed ticks...
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 658 })).toBe(false)
    // ...except on the slow cadence (every 5th tick).
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 658 })).toBe(true)
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 658 })).toBe(false)
    // A new vv height re-arms the hot window.
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 336 })).toBe(true)
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 336 })).toBe(true)
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 336 })).toBe(true)
  })

  it('reset restores the initial state', () => {
    const g = gate()
    g.shouldRun({ mobile: true, keyboardOpen: true, vvHeight: 336 })
    g.reset()
    expect(g.shouldRun({ mobile: true, keyboardOpen: false, vvHeight: 658 })).toBe(true)
  })
})

describe('bottom probe runner — diagnostics channel', () => {
  it('records one viewport-bottom-probe event with every field', () => {
    window.localStorage.setItem('tmuxgo-debug-mobile', '1')
    stubElementFromPoint((y) => (y <= 470 ? elementAt() : null))
    const runner = createViewportBottomProbeRunner({ gate: new ViewportBottomProbeGate(5, 1) })
    const sample = runner.tick(baseInput())
    expect(sample?.probeMethod).toBe('elementFromPoint')
    const state = (window as typeof window & { __tmuxgoMobileDiagnostics?: { events: Array<Record<string, unknown>> } })
      .__tmuxgoMobileDiagnostics
    const event = state?.events.at(-1)
    expect(event?.event).toBe('viewport-bottom-probe')
    expect(event).toMatchObject({
      probeMethod: 'elementFromPoint',
      probeVisibleBottom: 464,
      probeCanvasBottom: 464,
      vvBottom: 336.2,
      vvVsProbeDelta: 127.8,
      innerHeight: 658,
      vvHeight: 336.2,
      vkRectHeight: null,
      vkRectTop: null,
    })
    expect(typeof event?.probeCostMs).toBe('number')
    expect(event?.probeHits).toBe('344:E;368:E;392:E;416:E;440:E;464:E;488:N;512:N')
  })

  it('returns null and records nothing when the gate is closed', () => {
    window.localStorage.setItem('tmuxgo-debug-mobile', '1')
    const runner = createViewportBottomProbeRunner({ gate: new ViewportBottomProbeGate(0, 30) })
    expect(runner.tick(baseInput({ mobile: false }))).toBeNull()
    expect(
      (window as typeof window & { __tmuxgoMobileDiagnostics?: { events: unknown[] } }).__tmuxgoMobileDiagnostics,
    ).toBeUndefined()
  })

  it('swallows probe failures so the sync path is never affected', () => {
    const runner = createViewportBottomProbeRunner({
      gate: new ViewportBottomProbeGate(5, 1),
      record: () => {
        throw new Error('boom')
      },
    })
    stubElementFromPoint(() => elementAt())
    expect(runner.tick(baseInput())).toBeNull()
  })
})
