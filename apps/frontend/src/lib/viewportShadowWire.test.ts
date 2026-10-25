import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIEWPORT_SHADOW_DIFF_EVENT, VIEWPORT_SHADOW_SUMMARY_EVENT } from './mobile-diagnostics'
import {
  createViewportShadowWire,
  isViewportModelEnabled,
  isViewportShadowEnabled,
  VIEWPORT_MODEL_SWITCH_KEY,
  VIEWPORT_SHADOW_SWITCH_KEY,
  type ViewportShadowWireOptions,
} from './viewportShadowWire'

// jsdom has no visualViewport; the wire samples the real sampler, so the
// geometry has to come from the globals it reads.
function stubViewport(vvHeight: number, layoutHeight = 768, width = 390) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      width,
      height: vvHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      addEventListener() {},
      removeEventListener() {},
    },
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: layoutHeight })
}

type DiagnosticWindow = typeof window & {
  __tmuxgoMobileDiagnostics?: { events: Array<Record<string, unknown>> }
}

function diagnosticsEvents() {
  return (window as DiagnosticWindow).__tmuxgoMobileDiagnostics?.events ?? []
}

// keyboardIntent only becomes true for an explicitly marked input owner.
function focusKeyboardIntentInput() {
  const input = document.createElement('input')
  input.className = 'mobile-kb-input'
  document.body.appendChild(input)
  input.focus()
  return input
}

const legacy = { shellHeight: 768, keyboardOpen: false, keyboardInset: 0, baseHeight: 768, viewportWidth: 390 }

function makeWire(over: ViewportShadowWireOptions = {}) {
  const diffs: Parameters<NonNullable<ViewportShadowWireOptions['onDiff']>>[0][] = []
  const wakes: number[] = []
  const wire = createViewportShadowWire({
    onDiff: (diff) => diffs.push(diff),
    scheduleResample: (delayMs) => wakes.push(delayMs),
    ...over,
  })
  return { wire, diffs, wakes }
}

beforeEach(() => {
  stubViewport(768)
  window.localStorage.removeItem(VIEWPORT_SHADOW_SWITCH_KEY)
  window.localStorage.removeItem(VIEWPORT_MODEL_SWITCH_KEY)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.removeItem('tmuxgo-debug-mobile')
  window.localStorage.removeItem(VIEWPORT_SHADOW_SWITCH_KEY)
  window.localStorage.removeItem(VIEWPORT_MODEL_SWITCH_KEY)
  delete (window as DiagnosticWindow).__tmuxgoMobileDiagnostics
  Reflect.deleteProperty(window, 'visualViewport')
  document.body.innerHTML = ''
})

describe('viewport shadow wire — gating', () => {
  it('does nothing while disabled (desktop gate / kill switch)', () => {
    const { wire, diffs } = makeWire()
    wire.tick({ now: 1000, composition: false, enabled: false, legacy })
    expect(diffs).toEqual([])
    expect(wire.stats.ticks).toBe(0)
  })

  it('is off via localStorage or the query parameter', () => {
    expect(isViewportShadowEnabled()).toBe(true)
    window.localStorage.setItem(VIEWPORT_SHADOW_SWITCH_KEY, '0')
    expect(isViewportShadowEnabled()).toBe(false)
    window.localStorage.removeItem(VIEWPORT_SHADOW_SWITCH_KEY)
    window.history.replaceState(null, '', '/?viewport-shadow=0')
    expect(isViewportShadowEnabled()).toBe(false)
    window.history.replaceState(null, '', '/?viewport-shadow=1')
    expect(isViewportShadowEnabled()).toBe(true)
  })
})

describe('viewport shadow wire — divergence records', () => {
  it('reports the shell-height divergence between legacy and the new model', () => {
    stubViewport(446)
    const { wire, diffs } = makeWire()
    wire.tick({ now: 1000, composition: false, enabled: true, legacy })
    expect(wire.stats.ticks).toBe(1)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].fieldDiffs.map((d) => d.field)).toContain('shellHeight')
    expect(diffs[0].geometry).toMatchObject({ layoutHeight: 768, vvHeight: 446 })
    expect(diffs[0].phase).not.toBe('closed')
  })

  it('stays silent while legacy and the model agree', () => {
    const { wire, diffs } = makeWire()
    wire.tick({ now: 1000, composition: false, enabled: true, legacy })
    wire.tick({ now: 1100, composition: false, enabled: true, legacy })
    expect(wire.stats.ticks).toBe(2)
    expect(wire.stats.records).toBe(0)
    expect(diffs).toEqual([])
  })

  it('suppresses repeats of the same divergence within the dedupe window', () => {
    stubViewport(446)
    const { wire, diffs } = makeWire()
    wire.tick({ now: 1000, composition: false, enabled: true, legacy })
    wire.tick({ now: 1100, composition: false, enabled: true, legacy })
    expect(diffs).toHaveLength(1)
    expect(wire.stats.suppressed).toBe(1)
  })
})

describe('viewport shadow wire — nextWakeAt', () => {
  it('asks for a resample while the model is still converging', () => {
    stubViewport(446)
    const input = focusKeyboardIntentInput()
    const { wire, wakes } = makeWire()
    wire.tick({ now: 1000, composition: false, enabled: true, legacy })
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toBeGreaterThan(0)
    expect(wakes[0]).toBeLessThanOrEqual(2000)
    input.remove()
  })

  it('asks for nothing once the model is stable', () => {
    const { wire, wakes } = makeWire()
    wire.tick({ now: 1000, composition: false, enabled: true, legacy })
    expect(wakes).toEqual([])
  })
})

describe('viewport shadow wire — diagnostics channel', () => {
  it('emits viewport-shadow-diff through the existing diagnostics sink', () => {
    window.localStorage.setItem('tmuxgo-debug-mobile', '1')
    stubViewport(446)
    const { wire } = makeWire({ onDiff: undefined })
    wire.tick({ now: 1000, composition: false, enabled: true, legacy })
    const events = diagnosticsEvents()
    const event = events[events.length - 1]
    expect(event?.event).toBe(VIEWPORT_SHADOW_DIFF_EVENT)
    expect(event?.phase).toBeTruthy()
    expect(JSON.stringify(event)).not.toMatch(/localhost|127\.0\.0\.1/)
  })
})

describe('viewport shadow wire — failure isolation', () => {
  it('swallows a broken runner and warns only once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = {
      tick() {
        throw new Error('boom')
      },
      get stats() {
        return { ticks: 0, records: 0, suppressed: 0 }
      },
      get nextWakeAt() {
        return null
      },
    }
    const wire = createViewportShadowWire({ runner: runner as never })
    expect(() => wire.tick({ now: 1000, composition: false, enabled: true, legacy })).not.toThrow()
    expect(() => wire.tick({ now: 1100, composition: false, enabled: true, legacy })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('viewport model flag', () => {
  it('defaults to off and needs an explicit opt-in', () => {
    expect(isViewportModelEnabled()).toBe(false)
    window.localStorage.setItem(VIEWPORT_MODEL_SWITCH_KEY, '0')
    expect(isViewportModelEnabled()).toBe(false)
    window.localStorage.setItem(VIEWPORT_MODEL_SWITCH_KEY, '1')
    expect(isViewportModelEnabled()).toBe(true)
    window.localStorage.removeItem(VIEWPORT_MODEL_SWITCH_KEY)
    window.history.replaceState(null, '', '/?viewport-model=1')
    expect(isViewportModelEnabled()).toBe(true)
    window.history.replaceState(null, '', '/?viewport-model=0')
    expect(isViewportModelEnabled()).toBe(false)
  })
})

describe('viewport shadow wire — model snapshot handoff', () => {
  it('returns the snapshot the caller should apply, from a single normalize per tick', () => {
    stubViewport(446)
    let calls = 0
    const { wire } = makeWire({
      normalize: (state, obs) => {
        calls += 1
        return {
          state,
          snapshot: {
            fullLayoutSpace: { width: 390, height: 768 },
            visibleRegion: { width: 390, height: 446, offsetTop: 0 },
            occlusion: { height: 322, trusted: false, source: 'inferred' },
            keyboardPhase: 'closed',
            envGen: obs.envGen,
            measuredAt: obs.now,
          },
          nextWakeAt: null,
        }
      },
    })
    const snapshot = wire.tick({ now: 1000, composition: false, enabled: true, legacy })
    expect(snapshot?.visibleRegion.height).toBe(446)
    expect(calls).toBe(1)
    expect(wire.stats.ticks).toBe(1)
  })

  it('keeps sampling when recording is off, and tags diffs with the applied path', () => {
    stubViewport(446)
    const { wire, diffs } = makeWire()
    wire.tick({ now: 1000, composition: false, enabled: true, record: false, legacy })
    expect(wire.stats.ticks).toBe(1)
    expect(diffs).toEqual([])
    wire.tick({ now: 3000, composition: false, enabled: true, appliedBy: 'model', legacy })
    expect(diffs[0].appliedBy).toBe('model')
  })

  describe('viewport shadow wire — coverage summary', () => {
    it('emits a periodic summary with the agreement denominator', () => {
      const summaries: Parameters<NonNullable<ViewportShadowWireOptions['onSummary']>>[0][] = []
      const { wire } = makeWire({ onSummary: (summary) => summaries.push(summary), summaryIntervalMs: 1000 })
      // 两个一致 tick、一个分歧 tick，然后在窗口到期时收一条摘要
      wire.tick({ now: 1000, composition: false, enabled: true, legacy })
      wire.tick({ now: 1100, composition: false, enabled: true, legacy })
      stubViewport(446)
      wire.tick({ now: 1200, composition: false, enabled: true, legacy })
      expect(summaries).toEqual([])
      wire.tick({ now: 2100, composition: false, enabled: true, legacy })
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ ticks: 4, diverged: 1, appliedBy: 'legacy', reason: 'interval' })
      expect(summaries[0].agreed + summaries[0].inconclusive + summaries[0].diverged + summaries[0].suppressions).toBe(
        summaries[0].ticks,
      )
      // 窗口含触发这次摘要的 tick（1000 → 2100）
      expect(summaries[0].sessionCoverage.spanMs).toBe(1100)
    })

    it('counts a throwing tick as a failure instead of a silent gap', () => {
      const summaries: Parameters<NonNullable<ViewportShadowWireOptions['onSummary']>>[0][] = []
      const boom = () => {
        throw new Error('sampler down')
      }
      const { wire } = makeWire({ onSummary: (summary) => summaries.push(summary), normalize: boom })
      wire.tick({ now: 1000, composition: false, enabled: true, legacy })
      wire.flush(1200)
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ ticks: 1, failed: 1, agreed: 0 })
    })

    it('also emits on a tick budget so a busy viewport never goes unreported', () => {
      const summaries: Parameters<NonNullable<ViewportShadowWireOptions['onSummary']>>[0][] = []
      const { wire } = makeWire({ onSummary: (summary) => summaries.push(summary), summaryTickInterval: 3 })
      for (let i = 0; i < 3; i += 1) wire.tick({ now: 1000 + i, composition: false, enabled: true, legacy })
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ ticks: 3, reason: 'ticks' })
    })

    it('flushes on teardown and counts nothing while disabled', () => {
      const summaries: Parameters<NonNullable<ViewportShadowWireOptions['onSummary']>>[0][] = []
      const { wire } = makeWire({ onSummary: (summary) => summaries.push(summary) })
      wire.tick({ now: 1000, composition: false, enabled: false, legacy })
      // 没有样本的 flush 不发：空摘要会把「还没跑」说成「跑过了」
      wire.flush(1000)
      expect(summaries).toEqual([])
      wire.tick({ now: 1100, composition: false, enabled: true, appliedBy: 'model', legacy })
      wire.flush(1200)
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ ticks: 1, appliedBy: 'model', reason: 'flush' })
    })

    it('records the summary event without the debug switch', () => {
      // 没开 debug 时 diff 会被丢弃，摘要必须留下来，否则「无分歧」和「没运行」仍然不可分
      expect(window.localStorage.getItem('tmuxgo-debug-mobile')).toBeNull()
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: vi.fn().mockImplementation(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
      })
      const { wire } = makeWire({ summaryTickInterval: 1 })
      wire.tick({ now: 1000, composition: false, enabled: true, legacy })
      expect(diagnosticsEvents().filter((event) => event.event === VIEWPORT_SHADOW_SUMMARY_EVENT)).toHaveLength(1)
      expect(diagnosticsEvents().filter((event) => event.event === VIEWPORT_SHADOW_DIFF_EVENT)).toHaveLength(0)
    })
  })
})
