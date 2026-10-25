import { describe, expect, it } from 'vitest'
import { createViewportModelState } from './viewportContract'
import type { NormalizeResult, ViewportModelState, ViewportObservation } from './viewportContract'
import { normalize } from './viewportModel'

const W = 390
const FULL = 768

function obs(over: Partial<ViewportObservation> = {}): ViewportObservation {
  return {
    now: 1000,
    layoutViewport: { width: W, height: FULL },
    visualViewport: { width: W, height: FULL, offsetTop: 0, offsetLeft: 0, scale: 1 },
    virtualKeyboard: { available: false, overlaysContent: false, rect: null },
    inputOwner: 'terminal',
    keyboardIntent: false,
    composition: false,
    orientation: 'portrait',
    fullscreen: false,
    envGen: 1,
    ...over,
  }
}

// vv shrank but nothing else moved: the 2026-10-25 shape.
function shrunk(now: number, height = 446, extra: Partial<ViewportObservation> = {}) {
  return obs({
    now,
    keyboardIntent: true,
    visualViewport: { width: W, height, offsetTop: 0, offsetLeft: 0, scale: 1 },
    ...extra,
  })
}

function drive(seq: ViewportObservation[], initial: ViewportModelState = createViewportModelState()) {
  let state = initial
  const results: NormalizeResult[] = []
  for (const o of seq) {
    const r = normalize(state, o)
    state = r.state
    results.push(r)
  }
  return { state, results, last: results[results.length - 1] }
}

// Volatile bookkeeping (timestamps of internal transitions) excluded: the
// acceptance criterion is that the observable outcome converges.
function core(r: NormalizeResult) {
  return { snapshot: r.snapshot, baseline: r.state.trustedClosedBaseline, phase: r.state.phase }
}

describe('normalize — collapse regression', () => {
  it('opens from a shrinking visual viewport and keeps the full height out of the shell', () => {
    const closed = drive([obs({ now: 1000 })])
    expect(closed.last.snapshot.keyboardPhase).toBe('closed')
    expect(closed.last.snapshot.fullLayoutSpace).toEqual({ width: W, height: FULL })
    expect(closed.last.state.trustedClosedBaseline).toBe(FULL)

    const opening = drive([shrunk(1100)], closed.state)
    expect(opening.last.snapshot.keyboardPhase).toBe('opening')
    expect(opening.last.snapshot.visibleRegion.height).toBe(446)
    expect(opening.last.snapshot.fullLayoutSpace).toEqual({ width: W, height: FULL })
    expect(opening.last.snapshot.occlusion).toEqual({ height: 322, trusted: false, source: 'inferred' })
    expect(opening.last.nextWakeAt).toBe(1420)

    const open = drive([shrunk(1420)], opening.state)
    expect(open.last.snapshot.keyboardPhase).toBe('open')
    expect(open.last.snapshot.visibleRegion.height).toBe(446)
    expect(open.last.snapshot.fullLayoutSpace?.height).toBe(FULL)
    expect(open.last.nextWakeAt).toBeNull()
  })

  it('never derives a shell height from baseline minus occlusion twice', () => {
    const seq = [obs({ now: 1000 }), shrunk(1100), shrunk(1420), shrunk(1500, 380), shrunk(1900, 446)]
    const { results, last } = drive(seq)
    // 768 - 446 = 322 once; 768 - 2*322 = 124 is the historical collapse.
    for (const r of results) {
      const h = r.snapshot.visibleRegion.height
      expect(h).toBeGreaterThan(150)
      expect(Math.abs(h - 124)).toBeGreaterThan(20)
      expect(r.snapshot.occlusion.height).toBeLessThanOrEqual(FULL)
    }
    expect(last.snapshot.visibleRegion.height).toBe(446)
    expect(last.snapshot.fullLayoutSpace?.height).toBe(FULL)
  })
})

describe('normalize — convergence under duplicate and reordered notifications', () => {
  const a = obs({ now: 1000 })
  const b = shrunk(1100)
  const c = shrunk(1420)

  it('converges to the same snapshot for equivalent input sequences', () => {
    const direct = drive([a, b, c])
    const duplicated = drive([a, b, b, c, c])
    const reordered = drive([a, b, c, b, c])
    // A resample after opening (still the same geometry) must not regress.
    const late = drive([a, b, shrunk(1200), c])
    for (const other of [duplicated, reordered, late]) {
      expect(core(other.last)).toEqual(core(direct.last))
    }
  })

  it('is idempotent for a repeated observation at the same timestamp', () => {
    const once = drive([a, b, c])
    const twice = normalize(once.state, c)
    expect(twice.snapshot).toEqual(once.last.snapshot)
    expect(core(twice)).toEqual(core(once.last))
  })
})

describe('normalize — phase machine', () => {
  it('reports unknown when nothing is measurable instead of guessing', () => {
    const { last } = drive([
      obs({ visualViewport: null, virtualKeyboard: { available: false, overlaysContent: false, rect: null } }),
    ])
    expect(last.snapshot.keyboardPhase).toBe('unknown')
    expect(last.snapshot.fullLayoutSpace).toBeNull()
    expect(last.state.trustedClosedBaseline).toBeNull()
    expect(last.snapshot.visibleRegion).toEqual({ width: W, height: FULL, offsetTop: 0 })
  })

  it('stays unknown for occlusion without any keyboard evidence', () => {
    const { last } = drive([shrunk(1000, 446, { keyboardIntent: false })])
    expect(last.snapshot.keyboardPhase).toBe('unknown')
    expect(last.snapshot.occlusion.trusted).toBe(false)
    expect(last.snapshot.fullLayoutSpace).toBeNull()
  })

  it('opens immediately on a trusted keyboard rect (cold start, keyboard already up)', () => {
    const { last } = drive([
      obs({
        now: 1000,
        keyboardIntent: true,
        layoutViewport: { width: W, height: FULL },
        visualViewport: { width: W, height: 446, offsetTop: 0, offsetLeft: 0, scale: 1 },
        virtualKeyboard: { available: true, overlaysContent: true, rect: { x: 0, y: 446, width: W, height: 322 } },
      }),
    ])
    expect(last.snapshot.keyboardPhase).toBe('open')
    expect(last.snapshot.occlusion).toEqual({ height: 322, trusted: true, source: 'virtual-keyboard' })
    expect(last.snapshot.visibleRegion.height).toBe(446)
  })

  it('deducts a single occlusion when the keyboard rect and the viewport gap disagree', () => {
    const { last } = drive([
      obs({
        now: 1000,
        keyboardIntent: true,
        visualViewport: { width: W, height: 446, offsetTop: 0, offsetLeft: 0, scale: 1 },
        virtualKeyboard: { available: true, overlaysContent: true, rect: { x: 0, y: 446, width: W, height: 322 } },
      }),
    ])
    expect(last.snapshot.occlusion.height).toBe(322)
    expect(last.snapshot.occlusion.height).not.toBe(644)
    expect(last.snapshot.visibleRegion.height).toBe(446)
  })

  it('keeps an open keyboard while focus is lost, then closes on geometry', () => {
    const open = drive([obs({ now: 1000 }), shrunk(1100), shrunk(1420)])
    expect(open.last.snapshot.keyboardPhase).toBe('open')

    const blurred = drive([shrunk(1500, 446, { keyboardIntent: false })], open.state)
    expect(blurred.last.snapshot.keyboardPhase).toBe('open')
    expect(blurred.last.snapshot.visibleRegion.height).toBe(446)

    const closing = drive([obs({ now: 1600 })], blurred.state)
    expect(closing.last.snapshot.keyboardPhase).toBe('closing')
    expect(closing.last.nextWakeAt).toBe(1920)

    const closed = drive([obs({ now: 1920 })], closing.state)
    expect(closed.last.snapshot.keyboardPhase).toBe('closed')
    expect(closed.last.snapshot.visibleRegion.height).toBe(FULL)
    expect(closed.last.nextWakeAt).toBeNull()
  })

  it('opens after the opening grace when geometry never settles', () => {
    const seq = [obs({ now: 0 }), shrunk(100, 400), shrunk(200, 500), shrunk(300, 400), shrunk(1600, 520)]
    const { results } = drive(seq)
    expect(results.slice(0, 4).map((r) => r.snapshot.keyboardPhase)).toEqual([
      'closed',
      'opening',
      'opening',
      'opening',
    ])
    expect(results[4].snapshot.keyboardPhase).toBe('open')
    expect(results[4].snapshot.visibleRegion.height).toBe(520)
  })
})

describe('normalize — trusted closed baseline', () => {
  it('is discarded when envGen changes', () => {
    const before = drive([obs({ now: 1000 })])
    expect(before.state.trustedClosedBaseline).toBe(FULL)

    const after = drive([shrunk(1100, 446, { envGen: 2 })], before.state)
    expect(after.last.snapshot.envGen).toBe(2)
    expect(after.last.state.trustedClosedBaseline).toBeNull()
    expect(after.last.snapshot.fullLayoutSpace).toBeNull()
    expect(after.last.snapshot.keyboardPhase).toBe('opening')

    const resolved = drive([shrunk(1420, 446, { envGen: 2 })], after.state)
    expect(resolved.last.state.trustedClosedBaseline).toBeNull()
    expect(resolved.last.snapshot.fullLayoutSpace).toBeNull()
  })

  it('is only written by an unobstructed, intent-free visual viewport reading', () => {
    const occluded = drive([shrunk(1000, 446)])
    expect(occluded.last.state.trustedClosedBaseline).toBeNull()

    // Resize-mode keyboard: layout viewport shrank too, so the gap reads zero
    // and intent is the only hint that this is not the full height.
    const resized = drive([
      obs({ now: 1000 }),
      obs({
        now: 1100,
        keyboardIntent: true,
        layoutViewport: { width: W, height: 446 },
        visualViewport: { width: W, height: 446, offsetTop: 0, offsetLeft: 0, scale: 1 },
      }),
    ])
    expect(resized.last.state.trustedClosedBaseline).toBe(FULL)
    expect(resized.last.snapshot.fullLayoutSpace?.height).toBe(FULL)
    expect(resized.last.snapshot.visibleRegion.height).toBe(446)
  })

  it('does not latch a large unexplained shrink as the new baseline', () => {
    const before = drive([obs({ now: 1000 })])
    const shrunkLayout = drive([obs({ now: 1100, layoutViewport: { width: W, height: 500 } })], before.state)
    expect(shrunkLayout.last.state.trustedClosedBaseline).toBe(FULL)
    expect(shrunkLayout.last.snapshot.fullLayoutSpace?.height).toBe(FULL)
  })
})

// 复审探针（viewport-review-probes.jsonl）转成的回归用例：
// 输入序列按探针原样复刻，断言目标行为。
describe('normalize — review probe regressions', () => {
  const L = 800
  const kbObs = (over: Partial<ViewportObservation> = {}) =>
    obs({
      layoutViewport: { width: 390, height: L },
      visualViewport: { width: 390, height: L, offsetTop: 0, offsetLeft: 0, scale: 1 },
      ...over,
    })

  it('overlay_full_visual_viewport: deducts the overlaying keyboard from the visible region', () => {
    const seed = drive([kbObs({ now: 1000 })])
    const { last } = drive(
      [
        kbObs({
          now: 1100,
          inputOwner: 'terminal',
          keyboardIntent: true,
          virtualKeyboard: { available: true, overlaysContent: true, rect: { x: 0, y: 500, width: 390, height: 300 } },
        }),
      ],
      seed.state,
    )
    expect(last.snapshot.visibleRegion.height).toBe(500)
    expect(last.snapshot.occlusion).toEqual({ height: 300, trusted: true, source: 'virtual-keyboard' })
    // 只扣一次：绝不是 rect(300) + gap(0) 之外的 600，也不是 800 原样
    expect(last.snapshot.occlusion.height).not.toBe(600)
    expect(last.snapshot.keyboardPhase).not.toBe('closed')
  })

  it('overlay rect does not double-deduct an already-shrunk visual viewport', () => {
    const { last } = drive([
      kbObs({
        now: 1000,
        keyboardIntent: true,
        visualViewport: { width: 390, height: 500, offsetTop: 0, offsetLeft: 0, scale: 1 },
        virtualKeyboard: { available: true, overlaysContent: true, rect: { x: 0, y: 500, width: 390, height: 300 } },
      }),
    ])
    expect(last.snapshot.visibleRegion.height).toBe(500)
    expect(last.snapshot.occlusion.height).toBe(300)
    expect(last.snapshot.occlusion.trusted).toBe(true)
  })

  it('both_viewports_resize: gap=0 is not proof of "no keyboard"', () => {
    const seed = drive([kbObs({ now: 1000 })])
    expect(seed.state.trustedClosedBaseline).toBe(L)
    const { last } = drive(
      [
        kbObs({
          now: 1100,
          inputOwner: 'terminal',
          keyboardIntent: true,
          layoutViewport: { width: 390, height: 500 },
          visualViewport: { width: 390, height: 500, offsetTop: 0, offsetLeft: 0, scale: 1 },
        }),
      ],
      seed.state,
    )
    expect(last.snapshot.keyboardPhase).not.toBe('closed')
    expect(last.snapshot.keyboardPhase).toBe('unknown')
    // 也不许把双缩当成无遮挡证据写进基线
    expect(last.state.trustedClosedBaseline).toBe(L)
    expect(last.snapshot.fullLayoutSpace).toEqual({ width: 390, height: L })
  })

  it('cold_start_known_keyboard_rect: a live rect vetoes the trusted baseline', () => {
    const { last } = drive([
      kbObs({
        now: 1000,
        inputOwner: 'overlay',
        keyboardIntent: false,
        layoutViewport: { width: 390, height: 500 },
        visualViewport: { width: 390, height: 500, offsetTop: 0, offsetLeft: 0, scale: 1 },
        virtualKeyboard: { available: true, overlaysContent: false, rect: { x: 0, y: 500, width: 390, height: 300 } },
      }),
    ])
    expect(last.snapshot.keyboardPhase).toBe('unknown')
    expect(last.state.trustedClosedBaseline).toBeNull()
    expect(last.snapshot.fullLayoutSpace).toBeNull()
    // 不扣像素（vv 已经不含键盘），但证据保留：这正是"不扣像素 ≠ 丢证据"
    expect(last.snapshot.visibleRegion.height).toBe(500)
    expect(last.snapshot.occlusion).toEqual({ height: 300, trusted: true, source: 'virtual-keyboard' })
  })

  it('weak_occlusion_oscillation: 70-119px band converges to indeterminate instead of flapping', () => {
    const seed = drive([kbObs({ now: 1000 })])
    let state = seed.state
    const steps: Array<{ phase: string; wake: number | null }> = []
    for (const now of [1100, 1101, 1421, 1422, 1742]) {
      const r = normalize(
        state,
        kbObs({
          now,
          inputOwner: 'terminal',
          keyboardIntent: true,
          visualViewport: { width: 390, height: 710, offsetTop: 0, offsetLeft: 0, scale: 1 },
        }),
      )
      state = r.state
      steps.push({ phase: r.snapshot.keyboardPhase, wake: r.nextWakeAt })
    }
    expect(steps.map((step) => step.phase)).toEqual(Array(5).fill('unknown'))
    expect(steps.every((step) => step.wake === null)).toBe(true)

    // 遮挡加深到高阈后能正常收敛到 open（滞回不会把状态卡死）
    const strong = normalize(
      state,
      kbObs({
        now: 2000,
        inputOwner: 'terminal',
        keyboardIntent: true,
        visualViewport: { width: 390, height: 600, offsetTop: 0, offsetLeft: 0, scale: 1 },
      }),
    )
    expect(strong.snapshot.keyboardPhase).toBe('opening')
    const settled = normalize(
      strong.state,
      kbObs({
        now: 2400,
        inputOwner: 'terminal',
        keyboardIntent: true,
        visualViewport: { width: 390, height: 600, offsetTop: 0, offsetLeft: 0, scale: 1 },
      }),
    )
    expect(settled.snapshot.keyboardPhase).toBe('open')
  })

  it('old_environment_accepted: a stale envGen is ignored, not adopted', () => {
    const current = drive([kbObs({ now: 1000, envGen: 2 })])
    expect(current.state.envGen).toBe(2)
    expect(current.state.trustedClosedBaseline).toBe(L)
    const { last } = drive(
      [
        kbObs({
          now: 1100,
          envGen: 1,
          layoutViewport: { width: 390, height: 900 },
          visualViewport: { width: 390, height: 900, offsetTop: 0, offsetLeft: 0, scale: 1 },
        }),
      ],
      current.state,
    )
    expect(last.state.envGen).toBe(2)
    expect(last.state.trustedClosedBaseline).toBe(L)
    expect(last.snapshot.envGen).toBe(2)
    expect(last.snapshot.fullLayoutSpace).toEqual({ width: 390, height: L })
    expect(last.nextWakeAt).toBeNull()
  })

  it('keeps hysteresis between open and closing instead of exiting at the entry threshold', () => {
    const opened = drive([
      kbObs({ now: 1000 }),
      kbObs({
        now: 1100,
        keyboardIntent: true,
        visualViewport: { width: 390, height: 500, offsetTop: 0, offsetLeft: 0, scale: 1 },
      }),
      kbObs({
        now: 1420,
        keyboardIntent: true,
        visualViewport: { width: 390, height: 500, offsetTop: 0, offsetLeft: 0, scale: 1 },
      }),
    ])
    expect(opened.last.snapshot.keyboardPhase).toBe('open')
    // 遮挡回到 78px（弱区）仍算开：低阈是 70
    const weakStillOpen = drive(
      [
        kbObs({
          now: 1500,
          keyboardIntent: true,
          visualViewport: { width: 390, height: 722, offsetTop: 0, offsetLeft: 0, scale: 1 },
        }),
      ],
      opened.state,
    )
    expect(weakStillOpen.last.snapshot.keyboardPhase).toBe('open')
    // 低于 70 才退
    const closing = drive(
      [
        kbObs({
          now: 1600,
          keyboardIntent: true,
          visualViewport: { width: 390, height: 750, offsetTop: 0, offsetLeft: 0, scale: 1 },
        }),
      ],
      weakStillOpen.state,
    )
    expect(closing.last.snapshot.keyboardPhase).toBe('closing')
  })
})
