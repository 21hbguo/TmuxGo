// Trace replay harness: feed a recorded device trace through the machines.
//
// Two sides, one fixture:
// - `replayViewportTrace` drives the *legacy* machine (now the production
//   `createLegacyViewportMachine`, so the harness cannot drift from the wiring
//   the way the duplicated ref mirror did).
// - `replayViewportModel` drives the new pure `normalize()` over the same steps.
// - `replayDual` returns both for the same step, which is the evidence the
//   review asked for: "does the new model avoid the old collapse on the very
//   trace that produced it?"
//
// Trace fixtures only carry what the device logged (geometry + keyboard flags).
// The fields the new model also wants are therefore *approximated*, each marked
// at its derivation below; a trace never fabricates what was not measured.
import { createLegacyViewportMachine } from '@/lib/legacyViewportMachine'
import { createViewportModelState, type ViewportObservation, type ViewportSnapshot } from '../viewportContract'
import { normalize } from '../viewportModel'
import type { ViewportTraceFixture, ViewportTraceStep } from './viewportTraceFixtures'

export type ReplayOptions = {
  // 12:38 段来自带「关闭态超屏夹紧」的构建（design.md 事故链中夹紧在 latch 之前落地）：
  // 关闭态算出的壳高被夹到可见高度，才会把已应用的 appHeight 压成 446。
  closedClamp?: boolean
}

export type ReplayFrame = {
  at: number
  /** app-height applied after this sample (unchanged value = frame skipped). */
  appliedHeight: number
  /** stableClosedHeight after normalize(). */
  stableClosedHeight: number
  /** baseHeight the layout call received (stableClosedHeight || viewportBaseHeightRef). */
  layoutBaseHeight: number
  open: boolean
  inset: number
  /** false when the applied height did not change (tolerance / ime-composing / same value). */
  applied: boolean
}

export type ModelReplayFrame = {
  at: number
  /** visibleRegion.height the model would drive the shell to. */
  visibleHeight: number
  phase: ViewportSnapshot['keyboardPhase']
  occlusionHeight: number
  occlusionSource: ViewportSnapshot['occlusion']['source']
  /** fullLayoutSpace height (trusted closed baseline), null while unknown. */
  fullLayoutHeight: number | null
  /** Shell height after the wiring's apply guards (ime-composing holds). */
  appliedHeight: number
  applied: boolean
  /** The model's own resample request: a sparse trace needs these extra samples. */
  nextWakeAt: number | null
}

export type DualReplayFrame = {
  at: number
  legacy: ReplayFrame
  model: ModelReplayFrame
}

const mountHeightOf = (steps: readonly ViewportTraceStep[]) =>
  Math.round(steps[0].vvHeight || steps[0].innerHeight || 0)

// Mirror of ConsoleLayout.scheduleViewportSync() for the legacy path: the machine
// owns stable/base/applied/width and its own 36/48px hysteresis, so the harness
// only supplies samples. (Before F3 this file duplicated the ref juggling; the
// duplication is what let the harness keep replaying a fixed bug.)
export function replayViewportTrace(
  fixture: Pick<ViewportTraceFixture, 'steps' | 'closedClamp'>,
  options: ReplayOptions = {},
): ReplayFrame[] {
  const closedClamp = options.closedClamp ?? fixture.closedClamp
  const machine = createLegacyViewportMachine(mountHeightOf(fixture.steps))
  const frames: ReplayFrame[] = []
  for (const step of fixture.steps) {
    const state = machine.step({
      isMobileViewport: true,
      innerHeight: step.innerHeight,
      viewportHeight: step.vvHeight,
      viewportWidth: step.vvWidth,
      keyboardOpen: step.keyboardOpen,
      keyboardInset: step.keyboardInset,
      bodyKeyboardOpen: step.bodyKeyboardOpen,
      immersive: false,
      closedClampToViewport: closedClamp,
      now: step.at,
    })
    frames.push({
      at: step.at,
      appliedHeight: state.height,
      stableClosedHeight: state.closedBaseline,
      layoutBaseHeight: state.closedBaseline || state.baseHeight,
      open: state.open,
      inset: state.inset,
      // ime-composing samples advance the machine but must not write the shell;
      // `held` = the 36/48px hysteresis kept the previous height.
      applied: !step.imeComposing && !state.held,
    })
  }
  return frames
}

export function withSteps(steps: ViewportTraceStep[], closedClamp: boolean) {
  return { steps, closedClamp }
}

/** Duplicate every sample — extra resize notifications for an unchanged geometry. */
export function duplicateSteps(steps: readonly ViewportTraceStep[]): ViewportTraceStep[] {
  return steps.flatMap((step) => [step, step])
}

export function appliedHeights(frames: readonly ReplayFrame[]) {
  return frames.map((frame) => frame.appliedHeight)
}

/** Approximated observation for one trace step; see the file header. */
export function observationFromStep(step: ViewportTraceStep, envGen: number): ViewportObservation {
  const keyboardOpen = step.keyboardOpen || step.bodyKeyboardOpen
  return {
    now: Math.round(step.at),
    // layoutViewport is what innerHeight reported; vv is the visual viewport.
    layoutViewport: { width: Math.round(step.vvWidth), height: Math.round(step.innerHeight) },
    // offsetTop/offsetLeft/scale were not logged: 0/0/1 is "no pinch, no offset",
    // the only safe assumption (a trace with pinch would need its own fixture).
    visualViewport: {
      width: step.vvWidth,
      height: step.vvHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    },
    // The capture predates navigator.virtualKeyboard logging. Reporting it as
    // absent keeps the model on its "inferred occlusion" path, which is exactly
    // what the device was doing — not a fabricated keyboard rect.
    virtualKeyboard: { available: false, overlaysContent: false, rect: null },
    // Active element was not logged; the keyboard flag is the best available
    // proxy for "an input with keyboard intent owns focus".
    inputOwner: keyboardOpen ? 'terminal' : 'none',
    keyboardIntent: keyboardOpen,
    composition: step.imeComposing === true,
    orientation: step.vvWidth < step.innerHeight ? 'portrait' : 'landscape',
    fullscreen: false,
    envGen,
  }
}

// The model side of the replay: one observation per step, applied through the
// wiring's guards (composition holds the shell, unchanged height is a no-op).
export function replayViewportModel(
  fixture: Pick<ViewportTraceFixture, 'steps'>,
  options: { envGen?: (step: ViewportTraceStep, index: number) => number } = {},
): ModelReplayFrame[] {
  let state = createViewportModelState()
  let appliedHeight = mountHeightOf(fixture.steps)
  const envGenOf = options.envGen ?? (() => 0)
  return fixture.steps.map((step, index) => {
    const result = normalize(state, observationFromStep(step, envGenOf(step, index)))
    state = result.state
    const snapshot = result.snapshot
    const visibleHeight = Math.round(snapshot.visibleRegion.height)
    const applied = !step.imeComposing && visibleHeight !== appliedHeight
    if (applied) appliedHeight = visibleHeight
    return {
      at: step.at,
      visibleHeight,
      phase: snapshot.keyboardPhase,
      occlusionHeight: Math.round(snapshot.occlusion.height),
      occlusionSource: snapshot.occlusion.source,
      fullLayoutHeight: snapshot.fullLayoutSpace ? Math.round(snapshot.fullLayoutSpace.height) : null,
      appliedHeight,
      applied,
      nextWakeAt: result.nextWakeAt === null ? null : Math.round(result.nextWakeAt),
    }
  })
}

/** Legacy machine and new model over the same steps. */
export function replayDual(
  fixture: Pick<ViewportTraceFixture, 'steps' | 'closedClamp'>,
  options: ReplayOptions = {},
): DualReplayFrame[] {
  const legacy = replayViewportTrace(fixture, options)
  const model = replayViewportModel(fixture)
  return legacy.map((frame, index) => ({ at: frame.at, legacy: frame, model: model[index] }))
}
