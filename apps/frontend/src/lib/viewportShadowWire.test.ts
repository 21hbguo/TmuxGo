import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIEWPORT_SHADOW_DIFF_EVENT } from './mobile-diagnostics'
import {
  createViewportShadowWire,
  isViewportShadowEnabled,
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
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.removeItem('tmuxgo-debug-mobile')
  window.localStorage.removeItem(VIEWPORT_SHADOW_SWITCH_KEY)
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
