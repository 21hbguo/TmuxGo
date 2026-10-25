// Coverage accounting for the viewport shadow run (E2).
//
// The shadow used to report only divergences, so "ran for an hour with no
// difference", "never sampled at all" and "sampled but every diff was
// throttled" were indistinguishable in a trace. This tracker keeps the
// denominator: how many ticks were actually classified, how many agreed, how
// many were incomparable (model phase unknown/transient) and how many
// divergences recovered.
//
// Classification is deliberately conservative: a tick where the model phase is
// not a stable open/closed state is counted as `unknown`/`transition`, never as
// "agrees with the legacy path" — a boolean projection of `unknown` is what
// made the old numbers look better than the evidence.
//
// Pure TS: no DOM, no timers; the wire feeds it one outcome per tick.
import type { KeyboardPhase } from '@/components/viewportContract'

export type ViewportShadowOutcome = 'agreed' | 'diverged' | 'suppressed' | 'failed'

export type ViewportShadowSummary = {
  ticks: number
  // Conclusive agreement: legacy diffed clean AND the model phase is stable.
  agreed: number
  // Divergence that produced a record.
  diverged: number
  // Divergence swallowed by the dedupe window.
  suppressions: number
  // Diff clean but the model phase is transient/unset: no evidence either way.
  inconclusive: number
  // Sampling/wiring failure: a tick that produced no model answer at all.
  failed: number
  // Identity: ticks === agreed + inconclusive + diverged + suppressions + failed.

  // Phase denominators (they overlap the outcome buckets above): `unknown` is
  // the incomparable share, `transition` covers opening/closing.
  unknown: number
  transition: number
  // Divergent → non-divergent handovers.
  recovered: number
  sessionCoverage: {
    // Observation-time span covered by this summary (ms).
    spanMs: number
    // Distinct layout-environment generations seen.
    envGens: number
    // Per-phase tick counts: the denominator behind `unknown`/`transition`.
    phases: Record<KeyboardPhase, number>
  }
}

function emptyPhases(): Record<KeyboardPhase, number> {
  return { unknown: 0, opening: 0, open: 0, closing: 0, closed: 0 }
}

export function isStablePhase(phase: KeyboardPhase): boolean {
  return phase === 'open' || phase === 'closed'
}

export type ViewportShadowCoverage = {
  /** One classified tick. `now` is observation time (ms). */
  note(outcome: ViewportShadowOutcome, phase: KeyboardPhase, envGen: number, now: number): void
  /** Current totals; does not reset. */
  summary(): ViewportShadowSummary
  /** Totals since the previous call, then restart the window. */
  drain(): ViewportShadowSummary
  reset(): void
}

export function createViewportShadowCoverage(): ViewportShadowCoverage {
  let ticks = 0
  let agreed = 0
  let diverged = 0
  let suppressions = 0
  let inconclusive = 0
  let failed = 0
  let unknown = 0
  let transition = 0
  let recovered = 0
  let firstAt: number | null = null
  let lastAt: number | null = null
  let phases = emptyPhases()
  const envGens = new Set<number>()
  let lastDiverged = false

  const reset = () => {
    ticks = 0
    agreed = 0
    diverged = 0
    suppressions = 0
    inconclusive = 0
    failed = 0
    unknown = 0
    transition = 0
    recovered = 0
    firstAt = null
    lastAt = null
    phases = emptyPhases()
    envGens.clear()
    lastDiverged = false
  }

  const summary = (): ViewportShadowSummary => ({
    ticks,
    agreed,
    diverged,
    suppressions,
    inconclusive,
    failed,
    unknown,
    transition,
    recovered,
    sessionCoverage: {
      spanMs: firstAt === null || lastAt === null ? 0 : Math.max(0, Math.round(lastAt - firstAt)),
      envGens: envGens.size,
      phases: { ...phases },
    },
  })

  return {
    note(outcome, phase, envGen, now) {
      ticks += 1
      phases[phase] += 1
      envGens.add(envGen)
      if (firstAt === null) firstAt = now
      lastAt = now
      const divergent = outcome !== 'agreed'
      if (outcome === 'diverged') diverged += 1
      else if (outcome === 'suppressed') suppressions += 1
      else if (outcome === 'failed') failed += 1
      else if (isStablePhase(phase)) agreed += 1
      else inconclusive += 1
      // Agreement reached after a divergence: the recovery latency the review
      // asked for cannot be computed from diffs alone.
      if (!divergent && lastDiverged) recovered += 1
      if (phase === 'unknown') unknown += 1
      else if (!isStablePhase(phase)) transition += 1
      // A suppressed tick is still divergent: recovery means "the diff is gone".
      lastDiverged = divergent
    },
    summary,
    drain() {
      const snapshot = summary()
      reset()
      return snapshot
    },
    reset,
  }
}
