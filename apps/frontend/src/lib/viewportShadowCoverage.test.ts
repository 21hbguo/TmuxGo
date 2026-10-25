import { describe, expect, it } from 'vitest'
import { createViewportShadowCoverage, isStablePhase } from './viewportShadowCoverage'

describe('viewport shadow coverage', () => {
  it('separates conclusive agreement from incomparable ticks', () => {
    const coverage = createViewportShadowCoverage()
    coverage.note('agreed', 'closed', 0, 0)
    coverage.note('agreed', 'open', 0, 100)
    // unknown/closing/opening must not be counted as "agrees with legacy"
    coverage.note('agreed', 'unknown', 0, 200)
    coverage.note('agreed', 'closing', 0, 300)
    coverage.note('agreed', 'opening', 0, 400)
    coverage.note('diverged', 'closed', 0, 500)
    coverage.note('suppressed', 'closed', 0, 600)
    const summary = coverage.summary()
    expect(summary).toMatchObject({
      ticks: 7,
      agreed: 2,
      diverged: 1,
      suppressions: 1,
      inconclusive: 3,
      unknown: 1,
      transition: 2,
    })
    // 三态可分的恒等式：一致 + 无法判断 + 分歧 + 被去重 = 总 tick 数
    expect(summary.agreed + summary.inconclusive + summary.diverged + summary.suppressions).toBe(summary.ticks)
    expect(summary.sessionCoverage.phases).toEqual({ unknown: 1, opening: 1, open: 1, closing: 1, closed: 3 })
    expect(summary.sessionCoverage.spanMs).toBe(600)
  })

  it('counts a recovery only after a recorded divergence', () => {
    const coverage = createViewportShadowCoverage()
    coverage.note('agreed', 'closed', 0, 0)
    coverage.note('diverged', 'closed', 0, 100)
    coverage.note('agreed', 'closed', 0, 200)
    expect(coverage.summary().recovered).toBe(1)
    // Suppressed ticks are still divergent: recovery means "diff is gone".
    coverage.note('diverged', 'closed', 0, 300)
    coverage.note('suppressed', 'closed', 0, 400)
    coverage.note('agreed', 'closed', 0, 500)
    expect(coverage.summary().recovered).toBe(2)
    expect(coverage.summary().suppressions).toBe(1)
  })

  it('tracks the env denominator and drains per window', () => {
    const coverage = createViewportShadowCoverage()
    coverage.note('agreed', 'closed', 0, 0)
    coverage.note('agreed', 'closed', 1, 100)
    coverage.note('diverged', 'open', 1, 200)
    const window = coverage.drain()
    expect(window).toMatchObject({ ticks: 3, agreed: 2, diverged: 1 })
    expect(window.sessionCoverage.envGens).toBe(2)
    // Drained: the next window starts empty, so totals never double-count.
    expect(coverage.summary().ticks).toBe(0)
    coverage.note('agreed', 'closed', 1, 300)
    expect(coverage.summary()).toMatchObject({ ticks: 1, agreed: 1 })
    expect(coverage.summary().sessionCoverage.envGens).toBe(1)
  })

  it('treats only open/closed as stable phases', () => {
    expect(['open', 'closed'].every((phase) => isStablePhase(phase as 'open' | 'closed'))).toBe(true)
    expect(['unknown', 'opening', 'closing'].some((phase) => isStablePhase(phase as 'unknown'))).toBe(false)
  })
})
