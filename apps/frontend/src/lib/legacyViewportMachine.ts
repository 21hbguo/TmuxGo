// Legacy viewport machine, kept alive as an isolated counterfactual after the
// new model takes over the shell height (stage 3).
//
// Why a dedicated machine: the legacy pure functions feed on their own previous
// output — `currentAppHeight` sets the open latch (`openingHeight`), which then
// becomes `stableClosedHeight`, which is the next closed baseline. Feeding them
// the height the *model* applied made the counterfactual latch 446 as a closed
// baseline and render 124px on a "vv shrinks first, keyboard flag lands later"
// sequence (F3 / v7_legacy_counterfactual_contamination).
//
// Contract:
// - Every piece of state below (stable state, base height, applied height,
//   previous width, env generation) belongs to the legacy machine alone. Model
//   output must never be written back into it — the caller reports the legacy
//   height out, never in.
// - `step()` returns the height the old path would show this tick (hysteresis
//   applied) plus the untouched pure-function outputs for the shadow diff.
// - Resets are explicit: a cold reset on mount/env change only. A flag hot
//   switch must NOT adopt the model shell height as the legacy baseline — that
//   is exactly the latch that produced 124px.
// Pure TS: no DOM, no timers.
import {
  createViewportStableState,
  getNextViewportStableState,
  getViewportLayoutState,
  type ViewportStableState,
} from '@/components/consoleLayoutViewport'

// Same apply guards as the legacy wiring: below these deltas the old path kept
// the previous height instead of writing a new one.
const CLOSED_APPLY_TOLERANCE = 36
const OPEN_APPLY_TOLERANCE = 48

export type LegacyViewportSample = {
  isMobileViewport: boolean
  innerHeight: number
  viewportHeight: number
  viewportWidth: number
  keyboardOpen: boolean
  keyboardInset: number
  bodyKeyboardOpen: boolean
  // Immersive shell pins the shell to the visible height; the legacy path did
  // the same, so the counterfactual has to model it.
  immersive: boolean
  // The 12:38 build clamped the closed shell to the visible height (design.md
  // incident chain). Not a behaviour of the current build: only replay
  // fixtures set it, to reproduce what the device actually did.
  closedClampToViewport?: boolean
  now: number
}

export type LegacyViewportResult = {
  /** Height the legacy path would show after its 36/48px hysteresis. */
  height: number
  /** Raw layout height before hysteresis. */
  nextHeight: number
  open: boolean
  inset: number
  baseHeight: number
  closedBaseline: number
  viewportWidth: number
  /** True when the hysteresis kept the previous applied height. */
  held: boolean
}

export type LegacyViewportMachine = {
  step(sample: LegacyViewportSample): LegacyViewportResult
  /** Height the legacy path has applied; only ever written by step()/resets. */
  readonly appliedHeight: number
  /** Cold reset: forget baseline, applied height and width history. */
  reset(seedHeight?: number): void
  /** Returns true when the env generation changed and the machine was reset. */
  noteEnvGen(envGen: number): boolean
  snapshot(): { stable: ViewportStableState; baseHeight: number; appliedHeight: number; viewportWidth: number }
}

export function createLegacyViewportMachine(seedHeight = 0): LegacyViewportMachine {
  const seeded = Math.max(0, Math.round(seedHeight || 0))
  let stable = createViewportStableState(seeded)
  let baseHeight = seeded
  let appliedHeight = seeded
  // 0 forces the first sample through the widthChanged branch, which re-anchors
  // the baseline from the observation (same as a fresh mount).
  let viewportWidth = 0
  let envGen: number | null = null
  // Env change is only known after the model tick of the current frame, so the
  // cold reset is deferred to the next step: the height this tick reported must
  // stay authoritative (a fallback may apply it).
  let resetPending = false

  const applyReset = (seed = 0) => {
    const next = Math.max(0, Math.round(seed || 0))
    stable = createViewportStableState(next)
    baseHeight = next
    appliedHeight = next
    viewportWidth = 0
  }
  const reset = (seed = 0) => {
    applyReset(seed)
    envGen = null
    resetPending = false
  }

  return {
    step(sample) {
      if (resetPending) {
        resetPending = false
        applyReset(0)
      }
      const previousWidth = viewportWidth
      stable = getNextViewportStableState({
        state: stable,
        isMobileViewport: sample.isMobileViewport,
        innerHeight: sample.innerHeight,
        viewportHeight: sample.viewportHeight,
        viewportWidth: sample.viewportWidth,
        previousViewportWidth: previousWidth,
        baseHeight,
        keyboardOpen: sample.keyboardOpen,
        bodyKeyboardOpen: sample.bodyKeyboardOpen,
        currentAppHeight: appliedHeight,
        now: sample.now,
      })
      const layoutBase = stable.stableClosedHeight || baseHeight
      const layout = getViewportLayoutState({
        isMobileViewport: sample.isMobileViewport,
        innerHeight: sample.innerHeight,
        viewportHeight: sample.viewportHeight,
        viewportWidth: sample.viewportWidth,
        previousViewportWidth: previousWidth,
        baseHeight: layoutBase,
        keyboardOpen: sample.keyboardOpen,
        keyboardInset: sample.keyboardInset,
        bodyKeyboardOpen: sample.bodyKeyboardOpen,
      })
      // A width change invalidates the applied height (old code zeroed it too).
      if (previousWidth !== layout.viewportWidth) appliedHeight = 0
      viewportWidth = layout.viewportWidth
      baseHeight = layout.baseHeight
      let nextHeight = sample.immersive
        ? Math.round(sample.viewportHeight || layout.nextHeight || sample.innerHeight || 0)
        : layout.nextHeight
      if (sample.closedClampToViewport && !layout.open && sample.viewportHeight > 0)
        nextHeight = Math.min(nextHeight, Math.round(sample.viewportHeight))
      const tolerance = layout.open ? OPEN_APPLY_TOLERANCE : CLOSED_APPLY_TOLERANCE
      const held = sample.isMobileViewport && appliedHeight > 0 && Math.abs(nextHeight - appliedHeight) < tolerance
      const height = held ? appliedHeight : nextHeight
      appliedHeight = height
      return {
        height,
        nextHeight,
        open: layout.open,
        inset: layout.inset,
        baseHeight: layout.baseHeight,
        closedBaseline: stable.stableClosedHeight,
        viewportWidth: layout.viewportWidth,
        held,
      }
    },
    get appliedHeight() {
      return appliedHeight
    },
    reset,
    noteEnvGen(nextGen) {
      if (envGen === nextGen) return false
      const changed = envGen !== null
      envGen = nextGen
      if (changed) resetPending = true
      return changed
    },
    snapshot() {
      return { stable, baseHeight, appliedHeight, viewportWidth }
    },
  }
}
