import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  KeyboardPhase,
  NormalizeResult,
  ViewportModelState,
  ViewportObservation,
  ViewportSnapshot,
} from './viewportContract'
import { createViewportModelState } from './viewportContract'
import {
  createViewportShadowRunner,
  ViewportShadowRunner,
  type LegacyViewportOutput,
  type ViewportNormalizeFn,
} from './viewportShadow'

function observation(over: Partial<ViewportObservation> = {}): ViewportObservation {
  return {
    now: 1000,
    layoutViewport: { width: 390, height: 768 },
    visualViewport: { width: 390, height: 768, offsetTop: 0, offsetLeft: 0, scale: 1 },
    virtualKeyboard: { available: false, overlaysContent: false, rect: null },
    inputOwner: 'none',
    keyboardIntent: false,
    composition: false,
    orientation: 'portrait',
    fullscreen: false,
    envGen: 0,
    ...over,
  }
}

function snapshot(over: Partial<ViewportSnapshot> = {}): ViewportSnapshot {
  return {
    fullLayoutSpace: { width: 390, height: 768 },
    visibleRegion: { width: 390, height: 768, offsetTop: 0 },
    occlusion: { height: 0, trusted: true, source: 'none' },
    keyboardPhase: 'closed',
    envGen: 0,
    measuredAt: 1000,
    ...over,
  }
}

// Fake normalize: advances `pendingHeight` by one per tick so state evolution is
// observable, and reports the phase/normalization the test asks for.
function fakeNormalize(
  next: (obs: ViewportObservation) => ViewportSnapshot = () => snapshot(),
  seen: ViewportModelState[] = [],
): ViewportNormalizeFn {
  return (state, obs) => {
    seen.push(state)
    const result: NormalizeResult = {
      state: { ...state, pendingHeight: (state.pendingHeight ?? 0) + 1, envGen: obs.envGen },
      snapshot: next(obs),
      nextWakeAt: null,
    }
    return result
  }
}

const legacy = (over: Partial<LegacyViewportOutput> = {}): LegacyViewportOutput => ({ shellHeight: 768, ...over })

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.removeItem('tmuxgo-debug-mobile')
  delete (window as typeof window & { __tmuxgoMobileDiagnostics?: unknown }).__tmuxgoMobileDiagnostics
})

describe('ViewportShadowRunner', () => {
  it('records nothing when legacy and next agree within tolerance', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height: 768.6, offsetTop: 0 } })),
    })
    expect(runner.tick(observation(), legacy())).toBeNull()
    expect(runner.stats).toEqual({ ticks: 1, records: 0, suppressed: 0, recovers: 0 })
  })

  it('emits a single record with every divergent field and deltas', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() =>
        snapshot({
          visibleRegion: { width: 390, height: 500, offsetTop: 0 },
          fullLayoutSpace: { width: 390, height: 768 },
          keyboardPhase: 'open',
          occlusion: { height: 268, trusted: true, source: 'virtual-keyboard' },
        }),
      ),
    })
    const diff = runner.tick(observation(), legacy({ shellHeight: 768, keyboardOpen: false, keyboardInset: 0 }))
    expect(diff).not.toBeNull()
    expect(diff?.fieldDiffs).toEqual([
      { field: 'shellHeight', legacy: 768, next: 500, delta: -268 },
      { field: 'keyboardOpen', legacy: false, next: true, delta: null },
      { field: 'keyboardInset', legacy: 0, next: 268, delta: 268 },
    ])
    expect(diff?.phase).toBe('open')
    expect(diff?.envGen).toBe(0)
    expect(diff?.suppressed).toBe(0)
    expect(runner.stats.records).toBe(1)
  })

  it('only reports fields the legacy side actually knows', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height: 500, offsetTop: 0 } })),
    })
    const diff = runner.tick(observation(), { shellHeight: 768 })
    expect(diff?.fieldDiffs.map((item) => item.field)).toEqual(['shellHeight'])
  })

  it('treats a null fullLayoutSpace as a value (delta null), not as agreement', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ fullLayoutSpace: null })),
    })
    const diff = runner.tick(observation(), legacy({ baseHeight: 768 }))
    expect(diff?.fieldDiffs).toEqual([{ field: 'baseHeight', legacy: 768, next: null, delta: null }])
    expect(diff?.geometry.baseline).toBeNull()
  })

  it('falls back to the trusted baseline in geometry when fullLayoutSpace is unknown', () => {
    const state: ViewportModelState = { ...createViewportModelState(), trustedClosedBaseline: 812 }
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ fullLayoutSpace: null })),
      state,
    })
    const diff = runner.tick(observation(), legacy({ baseHeight: 768 }))
    expect(diff?.geometry.baseline).toBe(812)
  })

  it('dedupes identical consequent diffs and reports how many were suppressed', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height: 500, offsetTop: 0 } })),
      minIntervalMs: 1000,
    })
    expect(runner.tick(observation({ now: 1000 }), legacy())).not.toBeNull()
    expect(runner.tick(observation({ now: 1100 }), legacy())).toBeNull()
    expect(runner.tick(observation({ now: 1200 }), legacy())).toBeNull()
    const later = runner.tick(observation({ now: 2100 }), legacy())
    expect(later?.suppressed).toBe(2)
    expect(runner.stats).toEqual({ ticks: 4, records: 2, suppressed: 2, recovers: 0 })
  })

  it('emits immediately when the divergent values change inside the dedupe window', () => {
    let height = 500
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height, offsetTop: 0 } })),
      minIntervalMs: 1000,
    })
    expect(runner.tick(observation({ now: 1000 }), legacy())).not.toBeNull()
    height = 420
    const second = runner.tick(observation({ now: 1050 }), legacy())
    expect(second?.fieldDiffs).toEqual([{ field: 'shellHeight', legacy: 768, next: 420, delta: -348 }])
    expect(second?.suppressed).toBe(0)
  })

  it('emits a recover record on agreement and re-emits after it', () => {
    let height = 500
    const normalize: ViewportNormalizeFn = (state, obs) => ({
      state: { ...state, pendingHeight: 1 },
      snapshot: snapshot({ visibleRegion: { width: 390, height, offsetTop: 0 }, measuredAt: obs.now }),
      nextWakeAt: null,
    })
    const runner = new ViewportShadowRunner({ normalize })
    expect(runner.tick(observation({ now: 1000 }), legacy())?.kind).toBe('diff')
    height = 768
    const recover = runner.tick(observation({ now: 1010 }), legacy())
    expect(recover?.kind).toBe('recover')
    expect(recover?.fieldDiffs).toEqual([{ field: 'shellHeight', legacy: 768, next: 768, delta: 0 }])
    expect(recover?.durationMs).toBe(10)
    expect(recover?.divergentTicks).toBe(1)
    height = 500
    expect(runner.tick(observation({ now: 1020 }), legacy())?.kind).toBe('diff')
    expect(runner.stats).toMatchObject({ records: 2, recovers: 1, suppressed: 0 })
  })

  it('advances model state across ticks and hands the previous state to normalize', () => {
    const seen: ViewportModelState[] = []
    const runner = createViewportShadowRunner({ normalize: fakeNormalize(() => snapshot(), seen) })
    runner.tick(observation({ now: 1000 }), legacy())
    runner.tick(observation({ now: 1010 }), legacy())
    runner.tick(observation({ now: 1020 }), legacy())
    expect(runner.state.pendingHeight).toBe(3)
    expect(seen.map((state) => state.pendingHeight)).toEqual([null, 1, 2])
  })

  it('keeps model state advancing even when the legacy comparison agrees', () => {
    const runner = new ViewportShadowRunner({ normalize: fakeNormalize(() => snapshot()) })
    for (let i = 0; i < 4; i += 1) runner.tick(observation({ now: 1000 + i }), legacy())
    expect(runner.state.pendingHeight).toBe(4)
    expect(runner.stats.records).toBe(0)
  })

  it('resets state and counters', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height: 500, offsetTop: 0 } })),
    })
    runner.tick(observation(), legacy())
    runner.reset()
    expect(runner.state.pendingHeight).toBeNull()
    expect(runner.stats).toEqual({ ticks: 0, records: 0, suppressed: 0, recovers: 0 })
    expect(runner.tick(observation({ now: 5 }), legacy())).not.toBeNull()
  })

  it('captures rounded, DOM-free geometry for replay', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() =>
        snapshot({
          visibleRegion: { width: 390, height: 500, offsetTop: 0 },
          keyboardPhase: 'open',
          occlusion: { height: 268, trusted: true, source: 'virtual-keyboard' },
        }),
      ),
    })
    const diff = runner.tick(
      observation({
        layoutViewport: { width: 390.4, height: 768.6 },
        visualViewport: { width: 390, height: 500.2, offsetTop: 12.4, offsetLeft: 0, scale: 1.25 },
        virtualKeyboard: { available: true, overlaysContent: true, rect: { x: 0, y: 500, width: 390, height: 268.4 } },
        inputOwner: 'terminal',
        keyboardIntent: true,
        composition: true,
        envGen: 3,
      }),
      legacy(),
    )
    expect(diff?.geometry).toEqual({
      layoutWidth: 390,
      layoutHeight: 769,
      vvHeight: 500,
      vvOffsetTop: 12,
      vvScale: 1.25,
      kbAvailable: true,
      kbOverlays: true,
      kbHeight: 268,
      owner: 'terminal',
      intent: true,
      composing: true,
      orientation: 'portrait',
      fullscreen: false,
      baseline: 768,
    })
    expect(diff?.envGen).toBe(3)
    expect(JSON.stringify(diff)).not.toMatch(/[<>]/)
  })
})

describe('recordViewportShadowDiff', () => {
  it('pushes a viewport-shadow-diff event through the existing diagnostics channel', async () => {
    window.localStorage.setItem('tmuxgo-debug-mobile', '1')
    const { recordViewportShadowDiff, VIEWPORT_SHADOW_DIFF_EVENT } = await import('@/lib/mobile-diagnostics')
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height: 500, offsetTop: 0 } })),
    })
    const diff = runner.tick(observation(), legacy())
    expect(diff).not.toBeNull()
    recordViewportShadowDiff(diff!)
    const state = (
      window as typeof window & {
        __tmuxgoMobileDiagnostics?: { events: Array<Record<string, unknown>> }
      }
    ).__tmuxgoMobileDiagnostics
    const event = state?.events.at(-1)
    expect(event?.event).toBe(VIEWPORT_SHADOW_DIFF_EVENT)
    expect(event?.fieldDiffs).toEqual([{ field: 'shellHeight', legacy: 768, next: 500, delta: -268 }])
    expect(event?.geometry).toMatchObject({ layoutHeight: 768, owner: 'none' })
  })
})

// --- E1 regressions: review §7 distortion probes ---
describe('shadow semantics: dedupe, phase projection, recovery', () => {
  it('dedupe_loses_changed_legacy_value: a moving legacy value is not a repeat', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height: 500, offsetTop: 0 } })),
      minIntervalMs: 1000,
    })
    const first = runner.tick(observation({ now: 1000 }), legacy({ shellHeight: 800 }))
    expect(first?.fieldDiffs).toEqual([{ field: 'shellHeight', legacy: 800, next: 500, delta: -300 }])
    const second = runner.tick(observation({ now: 1100 }), legacy({ shellHeight: 600 }))
    expect(second).not.toBeNull()
    expect(second?.fieldDiffs).toEqual([{ field: 'shellHeight', legacy: 600, next: 500, delta: -100 }])
    expect(runner.stats.suppressed).toBe(0)
  })

  it('treats phase and appliedBy as part of the dedupe identity', () => {
    let phase: KeyboardPhase = 'opening'
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() =>
        snapshot({ keyboardPhase: phase, visibleRegion: { width: 390, height: 500, offsetTop: 0 } }),
      ),
      minIntervalMs: 1000,
    })
    const first = runner.tick(observation({ now: 1000 }), legacy({ shellHeight: 768 }), 'model')
    expect(first?.phase).toBe('opening')
    phase = 'open'
    const convergence = runner.tick(observation({ now: 1050 }), legacy({ shellHeight: 768 }), 'model')
    // Same values, new phase: the opening→open edge must not be swallowed.
    expect(convergence).not.toBeNull()
    expect(convergence?.phase).toBe('open')
    const otherPath = runner.tick(observation({ now: 1100 }), legacy({ shellHeight: 768 }), 'legacy')
    expect(otherPath).not.toBeNull()
    expect(otherPath?.appliedBy).toBe('legacy')
  })

  it('unknown_projected_to_false: unknown never counts as agreement or divergence', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() =>
        snapshot({ keyboardPhase: 'unknown', visibleRegion: { width: 390, height: 500, offsetTop: 0 } }),
      ),
    })
    const diff = runner.tick(observation(), legacy({ shellHeight: 768, keyboardOpen: false }))
    expect(diff?.fieldDiffs.map((item) => item.field)).toEqual(['shellHeight'])
    expect(diff?.incomparable).toEqual(['keyboardOpen'])
    expect(diff?.phase).toBe('unknown')
  })

  it('keeps transitional phases out of the boolean comparison', () => {
    for (const phase of ['opening', 'closing'] as KeyboardPhase[]) {
      const runner = new ViewportShadowRunner({
        normalize: fakeNormalize(() =>
          snapshot({ keyboardPhase: phase, visibleRegion: { width: 390, height: 500, offsetTop: 0 } }),
        ),
      })
      const diff = runner.tick(observation(), legacy({ shellHeight: 768, keyboardOpen: true }))
      expect(diff?.fieldDiffs.map((item) => item.field)).toEqual(['shellHeight'])
      expect(diff?.incomparable).toEqual(['keyboardOpen'])
      expect(diff?.phase).toBe(phase)
    }
  })

  it('settled phases still compare the boolean', () => {
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() =>
        snapshot({ keyboardPhase: 'closed', visibleRegion: { width: 390, height: 500, offsetTop: 0 } }),
      ),
    })
    const diff = runner.tick(observation(), legacy({ shellHeight: 768, keyboardOpen: true }))
    expect(diff?.fieldDiffs.map((item) => item.field)).toEqual(['shellHeight', 'keyboardOpen'])
    expect(diff?.incomparable).toBeUndefined()
  })

  it('emits a recover record with duration, ticks and suppressed repeats', () => {
    let height = 500
    const runner = new ViewportShadowRunner({
      normalize: fakeNormalize(() => snapshot({ visibleRegion: { width: 390, height, offsetTop: 0 } })),
      minIntervalMs: 1000,
    })
    expect(runner.tick(observation({ now: 1000 }), legacy())?.kind).toBe('diff')
    expect(runner.tick(observation({ now: 1050 }), legacy())).toBeNull() // suppressed
    expect(runner.tick(observation({ now: 1100 }), legacy())).toBeNull() // suppressed
    height = 768
    const recover = runner.tick(observation({ now: 1300 }), legacy())
    expect(recover?.kind).toBe('recover')
    expect(recover?.observedAt).toBe(1300)
    expect(recover?.durationMs).toBe(300)
    expect(recover?.divergentTicks).toBe(3)
    expect(recover?.suppressed).toBe(2)
    expect(recover?.fieldDiffs).toEqual([{ field: 'shellHeight', legacy: 768, next: 768, delta: 0 }])
    expect(recover?.geometry.layoutHeight).toBe(768)
    expect(runner.stats).toEqual({ ticks: 4, records: 1, suppressed: 2, recovers: 1 })
  })

  it('does not emit recover records for steady agreement', () => {
    const runner = new ViewportShadowRunner({ normalize: fakeNormalize(() => snapshot()) })
    for (let i = 0; i < 5; i += 1) expect(runner.tick(observation({ now: 1000 + i }), legacy())).toBeNull()
    expect(runner.stats.recovers).toBe(0)
  })
})
