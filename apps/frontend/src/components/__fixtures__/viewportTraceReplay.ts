import { createViewportStableState, getNextViewportStableState, getViewportLayoutState } from '../consoleLayoutViewport'
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

const CLOSED_APPLY_TOLERANCE = 36
const OPEN_APPLY_TOLERANCE = 48

// Mirror of ConsoleLayout.scheduleViewportSync() for the viewport pure functions:
// same refs (stable state / base height / applied height / previous width), same
// apply guards. Replaying a trace therefore reproduces what the device did frame by
// frame, minus DOM work.
export function replayViewportTrace(
  fixture: Pick<ViewportTraceFixture, 'steps' | 'closedClamp'>,
  options: ReplayOptions = {},
): ReplayFrame[] {
  const closedClamp = options.closedClamp ?? fixture.closedClamp
  const steps = fixture.steps
  // Mount path: syncViewportMode() seeds base/stable/appHeight from the visible height.
  const mountHeight = Math.round(steps[0].vvHeight || steps[0].innerHeight || 0)
  let stable = createViewportStableState(mountHeight)
  let baseHeight = mountHeight
  let appHeight = mountHeight
  // viewportWidthRef starts at 0, so the first sample always reports widthChanged.
  let previousWidth = 0
  const frames: ReplayFrame[] = []
  for (const step of steps) {
    stable = getNextViewportStableState({
      state: stable,
      isMobileViewport: true,
      innerHeight: step.innerHeight,
      viewportHeight: step.vvHeight,
      viewportWidth: step.vvWidth,
      previousViewportWidth: previousWidth,
      baseHeight,
      keyboardOpen: step.keyboardOpen,
      bodyKeyboardOpen: step.bodyKeyboardOpen,
      currentAppHeight: appHeight,
      now: step.at,
    })
    const layoutBaseHeight = stable.stableClosedHeight || baseHeight
    const layout = getViewportLayoutState({
      isMobileViewport: true,
      innerHeight: step.innerHeight,
      viewportHeight: step.vvHeight,
      viewportWidth: step.vvWidth,
      previousViewportWidth: previousWidth,
      baseHeight: layoutBaseHeight,
      keyboardOpen: step.keyboardOpen,
      keyboardInset: step.keyboardInset,
      bodyKeyboardOpen: step.bodyKeyboardOpen,
    })
    previousWidth = layout.viewportWidth
    baseHeight = layout.baseHeight
    let nextHeight = layout.nextHeight
    // The clamped build never let the shell exceed the visible region.
    if (closedClamp && !layout.open && step.vvHeight > 0) nextHeight = Math.min(nextHeight, Math.round(step.vvHeight))
    const tolerance = layout.open ? OPEN_APPLY_TOLERANCE : CLOSED_APPLY_TOLERANCE
    const skipped = !!appHeight && Math.abs(nextHeight - appHeight) < tolerance
    // ime-composing samples advance the machine but must not write the shell.
    const applied = !step.imeComposing && !skipped
    if (applied) appHeight = nextHeight
    frames.push({
      at: step.at,
      appliedHeight: appHeight,
      stableClosedHeight: stable.stableClosedHeight,
      layoutBaseHeight,
      open: layout.open,
      inset: layout.inset,
      applied,
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
