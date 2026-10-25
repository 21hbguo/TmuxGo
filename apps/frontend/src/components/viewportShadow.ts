// Shadow comparator for the viewport model refactor (stage 1).
//
// Runs the new normalize() alongside the legacy layout math on the same
// observation stream and records divergences only — it never feeds layout.
// Pure TS: DOM sampling and diagnostics upload are injected by the caller, so
// the runner is deterministic and replayable in tests.
//
// Record hygiene: diffs carry numbers/phases/enums only (no DOM text, no
// element handles), so a trace stays useful after desensitization.
//
// Three semantics that must not lie (architecture review §7):
// - Dedupe identity is the full comparison state (both sides' values, phase,
//   envGen, appliedBy), not just the model side: a legacy value that moves
//   while the model stays put is a new observation, not a repeat.
// - A phase that is not settled ('opening'/'closing'/'unknown') must not be
//   projected to a boolean and counted as agreement; keyboardOpen is simply
//   incomparable then, and the raw phase travels in the record.
// - Divergence → agreement is an event of its own ('recover'), so a trace can
//   measure how long a disagreement lasted instead of only seeing its start.
import type {
  KeyboardPhase,
  NormalizeResult,
  ViewportModelState,
  ViewportObservation,
  ViewportSnapshot,
} from './viewportContract'
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

export type ViewportShadowRecordKind = 'diff' | 'recover'
export type ViewportShadowAppliedBy = 'model' | 'legacy'

export type ViewportShadowDiff = {
  // 'diff' = divergence record, 'recover' = the divergence ended. Absent is
  // read as 'diff' so records written before this field stay valid.
  kind?: ViewportShadowRecordKind
  // Which path actually drives the shell this tick; set by the wiring layer
  // (or passed to tick()). Absent = shadow-only run (legacy owns the shell).
  appliedBy?: ViewportShadowAppliedBy
  observedAt: number
  envGen: number
  // Raw model phase — keep the original value for coverage/unknown accounting.
  phase: KeyboardPhase
  fieldDiffs: ViewportShadowFieldDiff[]
  // Fields whose comparison was skipped this tick because the evidence cannot
  // decide them (keyboardOpen while the phase is transitional or unknown).
  // Never counted as agreement or divergence.
  incomparable?: ViewportShadowField[]
  // Divergent ticks suppressed by the dedupe window before this record.
  suppressed: number
  // 'recover' only: wall time since the first divergent tick, and how many
  // ticks were divergent in that span.
  durationMs?: number
  divergentTicks?: number
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

export type ViewportShadowStats = { ticks: number; records: number; suppressed: number; recovers: number }

const FIELDS: ViewportShadowField[] = ['shellHeight', 'keyboardOpen', 'keyboardInset', 'baseHeight', 'viewportWidth']
const FIELD_COUNT = FIELDS.length
const FIELD_KEYBOARD_OPEN = 1
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
  // Last *recorded* comparison identity (both sides, phase, env, appliedBy).
  private readonly lastLegacy: (number | boolean | null)[] = new Array(FIELD_COUNT).fill(null)
  private readonly lastNext: (number | boolean | null)[] = new Array(FIELD_COUNT).fill(null)
  private lastMask = 0
  private lastPhase: KeyboardPhase | null = null
  private lastEnvGen: number | null = null
  private lastAppliedBy: ViewportShadowAppliedBy | null = null
  private lastEmittedAt = Number.NEGATIVE_INFINITY
  private incomparableMask = 0
  // Divergence episode state (start time + tick count) for recover records.
  private divergenceActive = false
  private divergenceStartedAt = 0
  private divergentTicks = 0
  // Surfaced from the injected normalize result so the wiring layer can drive
  // its own resample timer without calling normalize a second time.
  private wakeAt: number | null = null
  // Last model snapshot; lets the wiring layer apply the model without
  // normalizing twice per tick.
  private lastSnapshot: ViewportSnapshot | null = null
  private suppressedSinceRecord = 0
  private tickCount = 0
  private recordCount = 0
  private suppressedCount = 0
  private recoverCount = 0

  constructor(options: ViewportShadowOptions) {
    this.normalize = options.normalize
    this.tolerancePx = options.tolerancePx ?? DEFAULT_TOLERANCE_PX
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.modelState = options.state ?? createViewportModelState()
  }

  get state(): ViewportModelState {
    return this.modelState
  }

  get nextWakeAt(): number | null {
    return this.wakeAt
  }

  get snapshot(): ViewportSnapshot | null {
    return this.lastSnapshot
  }

  get stats(): ViewportShadowStats {
    return {
      ticks: this.tickCount,
      records: this.recordCount,
      suppressed: this.suppressedCount,
      recovers: this.recoverCount,
    }
  }

  reset(state: ViewportModelState = createViewportModelState()): void {
    this.modelState = state
    this.lastMask = 0
    this.lastPhase = null
    this.lastEnvGen = null
    this.lastAppliedBy = null
    this.lastEmittedAt = Number.NEGATIVE_INFINITY
    this.incomparableMask = 0
    this.divergenceActive = false
    this.divergenceStartedAt = 0
    this.divergentTicks = 0
    this.wakeAt = null
    this.lastSnapshot = null
    this.suppressedSinceRecord = 0
    this.tickCount = 0
    this.recordCount = 0
    this.suppressedCount = 0
    this.recoverCount = 0
  }

  // One sample: advance the model, compare against legacy output, and return a
  // record only on a divergence (or the recover edge that closes one).
  // `appliedBy` optionally joins the dedupe identity; the wiring layer sets it
  // when the model actually drives the shell.
  tick(
    observation: ViewportObservation,
    legacy: LegacyViewportOutput,
    appliedBy?: ViewportShadowAppliedBy,
  ): ViewportShadowDiff | null {
    const result = this.normalize(this.modelState, observation)
    this.modelState = result.state
    this.wakeAt = result.nextWakeAt
    this.lastSnapshot = result.snapshot
    const snapshot = result.snapshot
    this.tickCount += 1

    const mask = this.compareAgainstLegacy(legacy, snapshot)
    if (mask === 0) {
      if (!this.divergenceActive) {
        // Steady agreement: zero allocation, nothing to report.
        this.lastMask = 0
        this.suppressedSinceRecord = 0
        return null
      }
      return this.buildRecover(observation, snapshot, appliedBy)
    }

    if (!this.divergenceActive) {
      this.divergenceActive = true
      this.divergenceStartedAt = observation.now
      this.divergentTicks = 0
    }
    this.divergentTicks += 1

    if (this.isDuplicate(mask, snapshot.keyboardPhase, observation.envGen, appliedBy, observation.now)) {
      this.suppressedSinceRecord += 1
      this.suppressedCount += 1
      return null
    }

    const fieldDiffs = this.collectDiffs(mask)
    this.captureIdentity(mask, snapshot.keyboardPhase, observation.envGen, appliedBy, observation.now)
    this.recordCount += 1
    const diff = this.buildRecord('diff', observation, snapshot, fieldDiffs, appliedBy)
    this.suppressedSinceRecord = 0
    return diff
  }

  // Fills scratch buffers and returns a bitmask of divergent fields.
  private compareAgainstLegacy(legacy: LegacyViewportOutput, snapshot: NormalizeResult['snapshot']): number {
    let mask = 0
    this.incomparableMask = 0
    mask = this.setField(0, mask, legacy.shellHeight, snapshot.visibleRegion.height, true)
    // A phase that is not settled cannot decide the boolean: transitional
    // (opening/closing) or unknown means "not comparable", not "false".
    const openProjection = phaseToKeyboardOpen(snapshot.keyboardPhase)
    mask = this.setField(FIELD_KEYBOARD_OPEN, mask, legacy.keyboardOpen, openProjection, openProjection !== null)
    mask = this.setField(2, mask, legacy.keyboardInset, snapshot.occlusion.height, true)
    mask = this.setField(
      3,
      mask,
      legacy.baseHeight,
      snapshot.fullLayoutSpace ? snapshot.fullLayoutSpace.height : null,
      true,
    )
    mask = this.setField(4, mask, legacy.viewportWidth, snapshot.visibleRegion.width, true)
    return mask
  }

  private setField(
    index: number,
    mask: number,
    legacyValue: number | boolean | undefined,
    nextValue: number | boolean | null,
    comparable: boolean,
  ): number {
    const known = legacyValue !== undefined
    this.legacyScratch[index] = known ? legacyValue : null
    this.nextScratch[index] = nextValue
    if (!known) return mask
    if (!comparable) {
      this.incomparableMask |= 1 << index
      return mask
    }
    return valuesDiffer(legacyValue, nextValue, this.tolerancePx) ? mask | (1 << index) : mask
  }

  // Identity = mask + both sides' values + phase + envGen + appliedBy. Legacy
  // values are part of it on purpose: a moving legacy baseline with a still
  // model is a new observation, not a repeat.
  private isDuplicate(
    mask: number,
    phase: KeyboardPhase,
    envGen: number,
    appliedBy: ViewportShadowAppliedBy | undefined,
    now: number,
  ): boolean {
    if (
      mask !== this.lastMask ||
      phase !== this.lastPhase ||
      envGen !== this.lastEnvGen ||
      (appliedBy ?? null) !== this.lastAppliedBy
    )
      return false
    if (now - this.lastEmittedAt >= this.minIntervalMs) return false
    for (let i = 0; i < FIELD_COUNT; i += 1) {
      if (!(mask & (1 << i))) continue
      if (valuesDiffer(this.lastNext[i], this.nextScratch[i], this.tolerancePx)) return false
      if (valuesDiffer(this.lastLegacy[i], this.legacyScratch[i], this.tolerancePx)) return false
    }
    return true
  }

  private captureIdentity(
    mask: number,
    phase: KeyboardPhase,
    envGen: number,
    appliedBy: ViewportShadowAppliedBy | undefined,
    now: number,
  ): void {
    this.lastMask = mask
    this.lastPhase = phase
    this.lastEnvGen = envGen
    this.lastAppliedBy = appliedBy ?? null
    this.lastEmittedAt = now
  }

  // Allocation happens only on the record path.
  private collectDiffs(mask: number): ViewportShadowFieldDiff[] {
    const diffs: ViewportShadowFieldDiff[] = []
    for (let i = 0; i < FIELD_COUNT; i += 1) {
      if (!(mask & (1 << i))) continue
      diffs.push(this.fieldDiff(i))
      this.lastLegacy[i] = this.legacyScratch[i]
      this.lastNext[i] = this.nextScratch[i]
    }
    return diffs
  }

  private fieldDiff(index: number): ViewportShadowFieldDiff {
    const legacyValue = this.legacyScratch[index]
    const nextValue = this.nextScratch[index]
    return {
      field: FIELDS[index],
      legacy: legacyValue,
      next: nextValue,
      delta:
        typeof legacyValue === 'number' && typeof nextValue === 'number' ? Math.round(nextValue - legacyValue) : null,
    }
  }

  private buildRecord(
    kind: ViewportShadowRecordKind,
    observation: ViewportObservation,
    snapshot: ViewportSnapshot,
    fieldDiffs: ViewportShadowFieldDiff[],
    appliedBy?: ViewportShadowAppliedBy,
  ): ViewportShadowDiff {
    const record: ViewportShadowDiff = {
      kind,
      observedAt: observation.now,
      envGen: observation.envGen,
      phase: snapshot.keyboardPhase,
      fieldDiffs,
      suppressed: this.suppressedSinceRecord,
      geometry: buildGeometry(observation, snapshot, this.modelState),
    }
    if (appliedBy) record.appliedBy = appliedBy
    if (this.incomparableMask !== 0) record.incomparable = maskedFields(this.incomparableMask)
    return record
  }

  // Divergence closed: emit the edge record with the final (now agreeing)
  // values for the fields that were divergent, plus how long it lasted.
  private buildRecover(
    observation: ViewportObservation,
    snapshot: ViewportSnapshot,
    appliedBy: ViewportShadowAppliedBy | undefined,
  ): ViewportShadowDiff {
    const fieldDiffs: ViewportShadowFieldDiff[] = []
    for (let i = 0; i < FIELD_COUNT; i += 1) if (this.lastMask & (1 << i)) fieldDiffs.push(this.fieldDiff(i))
    const record = this.buildRecord('recover', observation, snapshot, fieldDiffs, appliedBy)
    record.durationMs = Math.max(0, observation.now - this.divergenceStartedAt)
    record.divergentTicks = this.divergentTicks
    this.divergenceActive = false
    this.divergentTicks = 0
    this.divergenceStartedAt = 0
    this.lastMask = 0
    this.lastPhase = null
    this.lastEnvGen = null
    this.lastAppliedBy = null
    this.suppressedSinceRecord = 0
    this.recoverCount += 1
    return record
  }
}

// Only settled phases prove a boolean; transitional and unknown ones do not.
function phaseToKeyboardOpen(phase: KeyboardPhase): boolean | null {
  if (phase === 'open') return true
  if (phase === 'closed') return false
  return null
}

function maskedFields(mask: number): ViewportShadowField[] {
  const fields: ViewportShadowField[] = []
  for (let i = 0; i < FIELD_COUNT; i += 1) if (mask & (1 << i)) fields.push(FIELDS[i])
  return fields
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
