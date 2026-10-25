// Shadow comparator for the viewport model refactor (stage 1).
//
// Runs the new normalize() alongside the legacy layout math on the same
// observation stream and records divergences only — it never feeds layout.
// Pure TS: DOM sampling and diagnostics upload are injected by the caller, so
// the runner is deterministic and replayable in tests.
//
// Record hygiene: diffs carry numbers/phases/enums only (no DOM text, no
// element handles), so a trace stays useful after desensitization.
import type { KeyboardPhase, NormalizeResult, ViewportModelState, ViewportObservation } from './viewportContract'
import { createViewportModelState } from './viewportContract'

// V3's normalize(state, obs) — injected so this branch has no import edge to
// viewportModel.ts (which lands separately and meets here at wiring time).
export type ViewportNormalizeFn = (state: ViewportModelState, obs: ViewportObservation) => NormalizeResult

// Legacy output for one tick, as produced by consoleLayoutViewport.ts today.
export type LegacyViewportOutput = {
  shellHeight: number
  keyboardOpen?: boolean
  keyboardInset?: number
  baseHeight?: number
  viewportWidth?: number
}

export type ViewportShadowField = 'shellHeight' | 'keyboardOpen' | 'keyboardInset' | 'baseHeight' | 'viewportWidth'

export type ViewportShadowFieldDiff = {
  field: ViewportShadowField
  legacy: number | boolean | null
  next: number | boolean | null
  delta: number | null // numeric fields only; null for booleans/null
}

// Key observation geometry for replay — rounded, enum-only.
export type ViewportShadowGeometry = {
  layoutWidth: number
  layoutHeight: number
  vvHeight: number | null
  vvOffsetTop: number | null
  vvScale: number | null
  kbAvailable: boolean
  kbOverlays: boolean
  kbHeight: number | null
  owner: ViewportObservation['inputOwner']
  intent: boolean
  composing: boolean
  orientation: ViewportObservation['orientation']
  fullscreen: boolean
  baseline: number | null
}

export type ViewportShadowDiff = {
  observedAt: number
  envGen: number
  phase: KeyboardPhase
  fieldDiffs: ViewportShadowFieldDiff[]
  // Divergent ticks suppressed by the dedupe window before this record.
  suppressed: number
  geometry: ViewportShadowGeometry
}

export type ViewportShadowOptions = {
  normalize: ViewportNormalizeFn
  // Numeric differences at or below this are agreement (default 1px).
  tolerancePx?: number
  // Identical consequent diffs are re-emitted at most this often (default 1000ms).
  minIntervalMs?: number
  // Initial machine state; defaults to createViewportModelState().
  state?: ViewportModelState
}

export type ViewportShadowStats = { ticks: number; records: number; suppressed: number }

const FIELDS: ViewportShadowField[] = ['shellHeight', 'keyboardOpen', 'keyboardInset', 'baseHeight', 'viewportWidth']
const FIELD_COUNT = FIELDS.length
const DEFAULT_TOLERANCE_PX = 1
const DEFAULT_MIN_INTERVAL_MS = 1000

export class ViewportShadowRunner {
  private readonly normalize: ViewportNormalizeFn
  private readonly tolerancePx: number
  private readonly minIntervalMs: number
  private modelState: ViewportModelState
  // Reused scratch buffers keep the agreeing (common) path allocation-free.
  private readonly legacyScratch: (number | boolean | null)[] = new Array(FIELD_COUNT).fill(null)
  private readonly nextScratch: (number | boolean | null)[] = new Array(FIELD_COUNT).fill(null)
  private readonly lastEmitted: (number | boolean | null)[] = new Array(FIELD_COUNT).fill(null)
  private lastMask = 0
  private lastEmittedAt = Number.NEGATIVE_INFINITY
  private suppressedSinceRecord = 0
  private tickCount = 0
  private recordCount = 0
  private suppressedCount = 0

  constructor(options: ViewportShadowOptions) {
    this.normalize = options.normalize
    this.tolerancePx = options.tolerancePx ?? DEFAULT_TOLERANCE_PX
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.modelState = options.state ?? createViewportModelState()
  }

  get state(): ViewportModelState {
    return this.modelState
  }

  get stats(): ViewportShadowStats {
    return { ticks: this.tickCount, records: this.recordCount, suppressed: this.suppressedCount }
  }

  reset(state: ViewportModelState = createViewportModelState()): void {
    this.modelState = state
    this.lastMask = 0
    this.lastEmittedAt = Number.NEGATIVE_INFINITY
    this.suppressedSinceRecord = 0
    this.tickCount = 0
    this.recordCount = 0
    this.suppressedCount = 0
  }

  // One sample: advance the model, compare against legacy output, and return a
  // diff only when something diverged (null on agreement / throttled repeats).
  tick(observation: ViewportObservation, legacy: LegacyViewportOutput): ViewportShadowDiff | null {
    const result = this.normalize(this.modelState, observation)
    this.modelState = result.state
    const snapshot = result.snapshot
    this.tickCount += 1

    const mask = this.compareAgainstLegacy(legacy, snapshot)
    if (mask === 0) {
      // Back in agreement: the next divergence is a fresh event.
      this.lastMask = 0
      this.suppressedSinceRecord = 0
      return null
    }
    if (this.isDuplicate(mask, observation.now)) {
      this.suppressedSinceRecord += 1
      this.suppressedCount += 1
      return null
    }

    const fieldDiffs = this.collectDiffs(mask)
    this.lastMask = mask
    this.lastEmittedAt = observation.now
    this.recordCount += 1
    const diff: ViewportShadowDiff = {
      observedAt: observation.now,
      envGen: observation.envGen,
      phase: snapshot.keyboardPhase,
      fieldDiffs,
      suppressed: this.suppressedSinceRecord,
      geometry: buildGeometry(observation, snapshot, this.modelState),
    }
    this.suppressedSinceRecord = 0
    return diff
  }

  // Fills scratch buffers and returns a bitmask of divergent fields.
  private compareAgainstLegacy(legacy: LegacyViewportOutput, snapshot: NormalizeResult['snapshot']): number {
    let mask = 0
    mask = this.setField(0, mask, legacy.shellHeight, snapshot.visibleRegion.height)
    mask = this.setField(1, mask, legacy.keyboardOpen, isOpenPhase(snapshot.keyboardPhase))
    mask = this.setField(2, mask, legacy.keyboardInset, snapshot.occlusion.height)
    mask = this.setField(3, mask, legacy.baseHeight, snapshot.fullLayoutSpace ? snapshot.fullLayoutSpace.height : null)
    mask = this.setField(4, mask, legacy.viewportWidth, snapshot.visibleRegion.width)
    return mask
  }

  private setField(
    index: number,
    mask: number,
    legacyValue: number | boolean | undefined,
    nextValue: number | boolean | null,
  ): number {
    const known = legacyValue !== undefined
    this.legacyScratch[index] = known ? legacyValue : null
    this.nextScratch[index] = nextValue
    // Unknown on the legacy side is not a divergence.
    if (!known) return mask
    return valuesDiffer(legacyValue, nextValue, this.tolerancePx) ? mask | (1 << index) : mask
  }

  private isDuplicate(mask: number, now: number): boolean {
    if (mask !== this.lastMask) return false
    if (now - this.lastEmittedAt >= this.minIntervalMs) return false
    for (let i = 0; i < FIELD_COUNT; i += 1) {
      if (!(mask & (1 << i))) continue
      if (valuesDiffer(this.lastEmitted[i], this.nextScratch[i], this.tolerancePx)) return false
    }
    return true
  }

  // Allocation happens only on the record path.
  private collectDiffs(mask: number): ViewportShadowFieldDiff[] {
    const diffs: ViewportShadowFieldDiff[] = []
    for (let i = 0; i < FIELD_COUNT; i += 1) {
      if (!(mask & (1 << i))) continue
      const legacyValue = this.legacyScratch[i]
      const nextValue = this.nextScratch[i]
      this.lastEmitted[i] = nextValue
      diffs.push({
        field: FIELDS[i],
        legacy: legacyValue,
        next: nextValue,
        delta:
          typeof legacyValue === 'number' && typeof nextValue === 'number' ? Math.round(nextValue - legacyValue) : null,
      })
    }
    return diffs
  }
}

function isOpenPhase(phase: KeyboardPhase): boolean {
  // 'opening' still means "keyboard is up" as far as legacy booleans concern.
  return phase === 'open' || phase === 'opening'
}

function valuesDiffer(a: number | boolean | null, b: number | boolean | null, tolerancePx: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > tolerancePx
  return a !== b
}

function buildGeometry(
  observation: ViewportObservation,
  snapshot: NormalizeResult['snapshot'],
  state: ViewportModelState,
): ViewportShadowGeometry {
  const vv = observation.visualViewport
  const keyboard = observation.virtualKeyboard
  const baseline = snapshot.fullLayoutSpace ? snapshot.fullLayoutSpace.height : state.trustedClosedBaseline
  return {
    layoutWidth: Math.round(observation.layoutViewport.width),
    layoutHeight: Math.round(observation.layoutViewport.height),
    vvHeight: vv ? Math.round(vv.height) : null,
    vvOffsetTop: vv ? Math.round(vv.offsetTop) : null,
    vvScale: vv ? Math.round(vv.scale * 100) / 100 : null,
    kbAvailable: keyboard.available,
    kbOverlays: keyboard.overlaysContent,
    kbHeight: keyboard.rect ? Math.round(keyboard.rect.height) : null,
    owner: observation.inputOwner,
    intent: observation.keyboardIntent,
    composing: observation.composition,
    orientation: observation.orientation,
    fullscreen: observation.fullscreen,
    baseline: baseline === null ? null : Math.round(baseline),
  }
}

export function createViewportShadowRunner(options: ViewportShadowOptions): ViewportShadowRunner {
  return new ViewportShadowRunner(options)
}
