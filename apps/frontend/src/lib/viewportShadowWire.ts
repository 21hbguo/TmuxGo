'use client'
// Viewport model wiring: every viewport sync tick feeds one observation into
// the new model, reports divergences, and (when the model flag is on) returns
// the snapshot the shell should use.
//
// Two modes, one code path:
// - shadow (default): the legacy path stays the single writer; this module is
//   a read-only tap that records legacy-vs-model diffs.
// - model (flag on): the returned snapshot drives the shell height; the legacy
//   computation is kept only as the counterfactual fed to the diff.
// Nothing here mutates the shell, body classes or keyboard flags, and every
// entry point is wrapped so a wiring failure can never reach the real path.
import { normalize } from '@/components/viewportModel'
import { sampleViewportObservation, ViewportEnvTracker } from '@/components/viewportObservation'
import {
  createViewportShadowRunner,
  type LegacyViewportOutput,
  type ViewportNormalizeFn,
  type ViewportShadowDiff,
  type ViewportShadowStats,
  type ViewportShadowRunner,
} from '@/components/viewportShadow'
import type { KeyboardPhase, ViewportSnapshot } from '@/components/viewportContract'
import {
  recordViewportShadowDiff,
  recordViewportShadowSummary,
  type ViewportShadowSummaryRecord,
} from './mobile-diagnostics'
import { createViewportShadowCoverage, type ViewportShadowCoverage } from './viewportShadowCoverage'

// Kill switch for field triage: `localStorage['tmuxgo-viewport-shadow'] = '0'`
// or `?viewport-shadow=0` disables the shadow without a deploy.
export const VIEWPORT_SHADOW_SWITCH_KEY = 'tmuxgo-viewport-shadow'
const SHADOW_SWITCH_OFF = '0'
// Model takeover flag (stage 3): shell height only. Default off — a reload is
// the rollback, and turning it off restores the legacy path frame-for-frame.
export const VIEWPORT_MODEL_SWITCH_KEY = 'tmuxgo-viewport-model'
const MODEL_SWITCH_ON = '1'
// No real wake is useful beyond a couple of seconds; clamp so a stale model
// timestamp cannot park a long timer.
const MAX_WAKE_DELAY_MS = 2000
// Coverage heartbeat: once a minute, or every 240 ticks on a busy phone — either
// way the trace answers "did the shadow actually run, and did it agree?".
const SUMMARY_INTERVAL_MS = 60_000
const SUMMARY_TICK_INTERVAL = 240

export function isViewportShadowEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.localStorage.getItem(VIEWPORT_SHADOW_SWITCH_KEY) === SHADOW_SWITCH_OFF) return false
    if (new URLSearchParams(window.location.search).get('viewport-shadow') === SHADOW_SWITCH_OFF) return false
    return true
  } catch {
    // Private-mode / blocked storage must not disable the shadow by accident.
    return true
  }
}

export function isViewportModelEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.localStorage.getItem(VIEWPORT_MODEL_SWITCH_KEY) === MODEL_SWITCH_ON) return true
    return new URLSearchParams(window.location.search).get('viewport-model') === MODEL_SWITCH_ON
  } catch {
    // Blocked storage must not opt the user into a takeover by accident.
    return false
  }
}

export type ViewportShadowAppliedBy = 'model' | 'legacy'

export type ViewportShadowTickInput = {
  now: number
  composition: boolean
  // Caller-owned gate (mobile viewport, shadow/model flags); the wire never
  // re-reads matchMedia so tests can drive it deterministically.
  enabled: boolean
  // Emit diffs. Defaults to `enabled`; model mode keeps sampling even when the
  // shadow switch is off.
  record?: boolean
  appliedBy?: ViewportShadowAppliedBy
  legacy: LegacyViewportOutput
}

export type ViewportShadowWire = {
  // Returns this tick's model snapshot (null when disabled or failed) so the
  // caller can apply it without normalizing a second time.
  tick(input: ViewportShadowTickInput): ViewportSnapshot | null
  readonly stats: ViewportShadowStats
  // Coverage totals since the last emitted summary (window included).
  readonly coverage: ViewportShadowCoverage
  // Emit any pending coverage window (called on teardown / flag change).
  flush(now: number): void
}

export type ViewportShadowWireOptions = {
  onDiff?: (diff: ViewportShadowDiff) => void
  onSummary?: (summary: ViewportShadowSummaryRecord) => void
  summaryIntervalMs?: number
  summaryTickInterval?: number
  // Called when the model wants another sample (settle/grace deadlines).
  scheduleResample?: (delayMs: number) => void
  normalize?: ViewportNormalizeFn
  tracker?: ViewportEnvTracker
  runner?: ViewportShadowRunner
}

export function createViewportShadowWire(options: ViewportShadowWireOptions = {}): ViewportShadowWire {
  const tracker = options.tracker ?? new ViewportEnvTracker()
  const runner = options.runner ?? createViewportShadowRunner({ normalize: options.normalize ?? normalize })
  const onDiff = options.onDiff ?? recordViewportShadowDiff
  const onSummary = options.onSummary ?? recordViewportShadowSummary
  const summaryIntervalMs = options.summaryIntervalMs ?? SUMMARY_INTERVAL_MS
  const summaryTickInterval = options.summaryTickInterval ?? SUMMARY_TICK_INTERVAL
  const scheduleResample = options.scheduleResample
  const coverage = createViewportShadowCoverage()
  let warned = false
  let windowTicks = 0
  let lastSummaryAt: number | null = null
  let windowAppliedBy: ViewportShadowSummaryRecord['appliedBy'] = 'none'

  // Emission is best-effort: a diagnostics failure must never break the tick.
  const emitSummary = (now: number, reason: ViewportShadowSummaryRecord['reason']) => {
    const totals = coverage.drain()
    const appliedBy = windowAppliedBy
    windowTicks = 0
    lastSummaryAt = now
    windowAppliedBy = 'none'
    // An empty window proves nothing: only a sampled window is evidence.
    if (totals.ticks === 0) return
    try {
      onSummary({ ...totals, appliedBy, reason })
    } catch {
      // Diagnostics are not part of the layout contract.
    }
  }

  return {
    tick({ now, composition, enabled, record = enabled, appliedBy = 'legacy', legacy }) {
      if (!enabled) return null
      try {
        const envGen = tracker.sync()
        // Orientation comes from the tracker so the observation and envGen agree
        // on one identity (the tracker can freeze it while an occlusion is up).
        const observation = sampleViewportObservation({
          now,
          composition,
          envGen,
          orientation: tracker.resolvedOrientation ?? undefined,
        })
        const before = runner.stats
        const diff = runner.tick(observation, legacy)
        if (diff && record) onDiff({ ...diff, appliedBy })
        const after = runner.stats
        // The runner reports records/suppressions as cumulative counters, so the
        // per-tick classification comes from the deltas: coverage needs no field
        // of the compare/dedupe logic to know about it.
        coverage.note(
          diff !== null ? 'diverged' : after.suppressed > before.suppressed ? 'suppressed' : 'agreed',
          snapshotPhase(runner.snapshot),
          envGen,
          now,
        )
        windowTicks += 1
        if (appliedBy === 'model') windowAppliedBy = 'model'
        else if (windowAppliedBy === 'none') windowAppliedBy = 'legacy'
        if (lastSummaryAt === null) lastSummaryAt = now
        if (now - lastSummaryAt >= summaryIntervalMs) emitSummary(now, 'interval')
        else if (windowTicks >= summaryTickInterval) emitSummary(now, 'ticks')
        const wakeAt = runner.nextWakeAt
        if (wakeAt !== null && scheduleResample) {
          scheduleResample(Math.min(MAX_WAKE_DELAY_MS, Math.max(0, wakeAt - now)))
        }
        return runner.snapshot
      } catch (err) {
        // A failed tick is a real observation of the wiring, not a gap: count it
        // so a run where every tick throws cannot look like "no divergence".
        coverage.note('failed', 'unknown', 0, now)
        if (lastSummaryAt === null) lastSummaryAt = now
        // One warn per session: a broken shadow must not spam a phone console.
        if (!warned) {
          warned = true
          console.warn('[viewport-shadow] tick failed', err)
        }
        return null
      }
    },
    get stats() {
      return runner.stats
    },
    get coverage() {
      return coverage
    },
    flush(now) {
      emitSummary(now, 'flush')
    },
  }
}

// `unknown` is a real phase value, not "no snapshot": a missing snapshot means
// the tick failed, which the coverage window already counts as a tick.
function snapshotPhase(snapshot: ViewportSnapshot | null): KeyboardPhase {
  return snapshot ? snapshot.keyboardPhase : 'unknown'
}
