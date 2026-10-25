// Mobile viewport contract types — the single vocabulary for the viewport
// state machine refactor. Pure types only: no DOM reads, no timers.
//
// Invariants every implementation MUST keep:
// - trustedClosedBaseline is only updated by a trusted, unobstructed
//   observation taken in the SAME envGen. Applied appHeight must NEVER be
//   written back into it.
// - An occlusion is deducted at most once per snapshot.
// - Uncertainty is representable (KeyboardPhase 'unknown', null baselines) —
//   never force a boolean guess.
// - normalize() is pure: no DOM, no body classes, no timers; callers schedule
//   from nextWakeAt.

export type Rect = { x: number; y: number; width: number; height: number }

// Normalized input sampled once per tick. Events only trigger resampling;
// they are not interpreted individually.
export type ViewportObservation = {
  now: number
  layoutViewport: { width: number; height: number }
  // null when visualViewport API is absent — distinct from "measured zero".
  visualViewport: {
    width: number
    height: number
    offsetTop: number
    offsetLeft: number
    scale: number
  } | null
  virtualKeyboard: {
    available: boolean // navigator.virtualKeyboard exists
    overlaysContent: boolean // overlaysContent === true
    rect: Rect | null // keyboard rect when visible, else null
  }
  // Which surface owns text focus; keyboardIntent marks focus that expects an
  // on-screen keyboard (.mobile-kb-input et al). A focus WITHOUT intent must
  // not by itself prove keyboard state either way.
  inputOwner: 'terminal' | 'overlay' | 'none'
  keyboardIntent: boolean
  composition: boolean
  orientation: 'portrait' | 'landscape'
  fullscreen: boolean
  // Layout-environment generation: +1 whenever width/orientation/fullscreen
  // context changes; observations from an older envGen must not feed baselines.
  envGen: number
}

export type KeyboardPhase = 'unknown' | 'opening' | 'open' | 'closing' | 'closed'

// The three spaces, kept distinct on purpose:
// - fullLayoutSpace: unobstructed app layout extent for this env (may be
//   unknown → null). Feeds grid computation and baseline inference.
// - visibleRegion: what is actually displayable right now. Feeds shell,
//   dock, clip window.
// - terminal grid: owned elsewhere (TerminalSizeState); the plan addresses it.
export type ViewportSnapshot = {
  fullLayoutSpace: { width: number; height: number } | null
  visibleRegion: { width: number; height: number; offsetTop: number }
  occlusion: {
    height: number
    trusted: boolean // false = inferred, may revise
    source: 'virtual-keyboard' | 'inferred' | 'none'
  }
  keyboardPhase: KeyboardPhase
  envGen: number
  measuredAt: number
}

// Machine memory beyond the snapshot. Serializable and replayable.
export type ViewportModelState = {
  phase: KeyboardPhase
  // Historical inference only; exits all output formulas when null-safe.
  trustedClosedBaseline: number | null
  pendingHeight: number | null // converging candidate
  pendingSince: number
  phaseSince: number
  envGen: number
}

export type NormalizeResult = {
  state: ViewportModelState
  snapshot: ViewportSnapshot
  // Absolute time at which the caller should re-sample to keep converging
  // (settle waits, opening timeouts); null = next event is enough.
  nextWakeAt: number | null
}

export function createViewportModelState(): ViewportModelState {
  return {
    phase: 'unknown',
    trustedClosedBaseline: null,
    pendingHeight: null,
    pendingSince: 0,
    phaseSince: 0,
    envGen: 0,
  }
}

// Full layout decision for one snapshot. Produced by a pure function; every
// field has exactly one writer downstream.
export type LayoutPlan = {
  version: number
  shell: { height: number }
  dock: 'visible' | 'covered'
  terminal: {
    visibleHeight: number
    // 'keep' = occlusion-only change must NOT refit the grid.
    targetGrid: { cols: number; rows: number } | 'keep'
    clipTranslateY: number
    // Remainder (<1 row) handling; 'last-row' kept only during migration.
    remainderFill: 'background' | 'last-row'
    scrollAnchor: 'bottom' | 'keep'
  }
  requestRemoteResize: { cols: number; rows: number } | null
}
