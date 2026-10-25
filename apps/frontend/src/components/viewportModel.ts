// Viewport state machine — normalize(prev, obs) => {state, snapshot, nextWakeAt}.
//
// Pure by construction: no DOM, no body classes, no timers, no React. The only
// time source is obs.now; convergence is the caller's job via nextWakeAt.
//
// The 2026-10-25 collapse (vv=446 + keyboard flag not yet set => shell 769 =>
// 124px) cannot be expressed here: ViewportObservation carries no applied
// appHeight, so "feed the applied height back as a baseline" has no field to
// travel through, and normalize() refuses layout output as input.
//
// Thresholds intentionally mirror the legacy implicit machine
// (consoleLayoutViewport.ts / useMobileKeyboard.ts) so product behaviour does
// not drift. Deliberate differences, all noted at their use site:
// - settle is measured from geometry samples only, never from a flag flip;
// - the closed baseline is guarded against intent-driven shrinks (the legacy
//   "open latch" assumption) instead of being refreshed unconditionally;
// - the open direction has hysteresis: enter at OPEN, leave at CLOSE, so a
//   weak occlusion (70-119px) can never ping-pong between opening and closing.
//
// Coordinate spaces used here:
// - layoutViewport: the layout viewport (can itself shrink in resize mode).
// - visualViewport: what is displayable; offsetTop is its top in the same
//   client coordinates as virtualKeyboard.rect.
// The keyboard rect is only *deducted* from the visual viewport band it
// actually overlaps, so an already-shrunk visual viewport never loses the same
// pixels twice.
import type {
  KeyboardPhase,
  NormalizeResult,
  ViewportModelState,
  ViewportObservation,
  ViewportSnapshot,
} from './viewportContract'

const SETTLE_MS = 320 // VIEWPORT_SETTLE_MS
const GEOMETRY_TOLERANCE = 1 // VIEWPORT_STABLE_TOLERANCE
const OPEN_OCCLUSION_THRESHOLD = 120 // KEYBOARD_OPEN_THRESHOLD
const CLOSE_OCCLUSION_THRESHOLD = 70 // KEYBOARD_CLOSE_THRESHOLD
const OPENING_GRACE_MS = 1500 // KEYBOARD_VIEWPORT_GRACE_MS
// A drop of at least one legacy gap unit without keyboard intent is treated as
// browser chrome / stale keyboard rather than a new closed baseline.
const CLOSED_GAP_SUSPICION = 120 // CLOSED_VIEWPORT_GAP

type OcclusionResolution = {
  // Occluded extent relative to the *layout* space — the legacy "inset"
  // quantity, so a resize-mode gap and an overlay rect stay comparable.
  height: number
  // True when the platform handed us keyboard geometry (any overlaysContent).
  trusted: boolean
  source: 'virtual-keyboard' | 'inferred' | 'none'
  // Pixels the keyboard covers *inside* the visual viewport band: the amount
  // visibleRegion must drop. Zero in resize mode because vv already excludes it.
  vvOverlap: number
}

const px = (n: number) => Math.round(n || 0)
const clamp0 = (n: number) => (n > 0 ? n : 0)

function bandOverlap(aTop: number, aHeight: number, bTop: number, bHeight: number) {
  const top = Math.max(aTop, bTop)
  const bottom = Math.min(aTop + aHeight, bTop + bHeight)
  return clamp0(bottom - top)
}

// Occlusion is resolved to a single number per snapshot: "deduct once" is a
// structural property, not a caller discipline.
function resolveOcclusion(
  obs: ViewportObservation,
  layoutHeight: number,
  vvHeight: number | null,
  vvOffsetTop: number,
): OcclusionResolution {
  const kb = obs.virtualKeyboard
  const kbRect = kb.available && kb.rect && px(kb.rect.height) > 0 ? kb.rect : null
  const kbHeight = kbRect ? clamp0(px(kbRect.height)) : 0
  const gap = vvHeight === null ? null : clamp0(layoutHeight - vvHeight)

  if (kbRect) {
    // API geometry is authoritative on its own ("the keyboard is showing"),
    // independent of whether it happens to equal the layout-vv gap: in overlay
    // mode the gap is legitimately 0. Never add gap + rect.
    const height = Math.min(Math.max(layoutHeight, kbHeight), Math.max(kbHeight, gap ?? 0))
    return {
      height,
      trusted: true,
      source: 'virtual-keyboard',
      // Intersection with the visual viewport band, clamped: a keyboard below
      // an already-shrunk vv subtracts nothing from what is visible now.
      vvOverlap: vvHeight === null ? 0 : Math.min(vvHeight, bandOverlap(vvOffsetTop, vvHeight, px(kbRect.y), kbHeight)),
    }
  }
  if (gap !== null && gap > 0) return { height: gap, trusted: false, source: 'inferred', vvOverlap: 0 }
  return { height: 0, trusted: false, source: 'none', vvOverlap: 0 }
}

export function normalize(state: ViewportModelState, obs: ViewportObservation): NormalizeResult {
  const now = Math.max(0, px(obs.now))
  const envGen = obs.envGen
  const layoutW = clamp0(px(obs.layoutViewport.width))
  const layoutH = clamp0(px(obs.layoutViewport.height))
  const vv = obs.visualViewport
  const vvHeight = vv ? clamp0(px(vv.height)) : null
  const vvOffsetTop = vv ? px(vv.offsetTop) : 0

  // A stale generation is not a new environment: reject it outright. Do not
  // reset, do not write a baseline, and keep the phase we already have.
  // Live callers sample synchronously (tracker.sync() is monotonic), so this
  // path only matters for delayed/queued or replayed observations.
  if (envGen < state.envGen) {
    const staleHeight = state.trustedClosedBaseline ?? layoutH
    return {
      state,
      snapshot: {
        fullLayoutSpace:
          state.trustedClosedBaseline === null ? null : { width: layoutW, height: state.trustedClosedBaseline },
        visibleRegion: { width: layoutW, height: staleHeight, offsetTop: 0 },
        occlusion: { height: 0, trusted: false, source: 'none' },
        keyboardPhase: state.phase,
        envGen: state.envGen,
        measuredAt: now,
      },
      nextWakeAt: null,
    }
  }

  // envGen change (width / orientation / fullscreen) voids every baseline and
  // every in-flight candidate: the old numbers describe a different layout
  // environment and must not leak into the new one.
  const prev: ViewportModelState =
    state.envGen === envGen
      ? state
      : {
          phase: 'unknown',
          trustedClosedBaseline: null,
          pendingHeight: null,
          pendingSince: 0,
          phaseSince: now,
          envGen,
        }

  const occ = resolveOcclusion(obs, layoutH, vvHeight, vvOffsetTop)
  const intent = obs.keyboardIntent
  const overlaysContent = obs.virtualKeyboard.overlaysContent

  // Evidence and intent are separate axes on purpose.
  // - occ.trusted: the platform handed us keyboard geometry. It is evidence of
  //   "a keyboard exists" even when it deducts nothing (resize mode with a vv
  //   that has not caught up yet).
  // - overlayProof: the API says the keyboard floats over content, which is
  //   direct geometric proof that it is on screen.
  const vkEvidence = occ.trusted
  const overlayProof = vkEvidence && overlaysContent
  // Hysteresis: enter the open direction only at the high threshold (or with
  // overlay proof); leave it only below the low threshold. The 70-119px band is
  // deliberately indeterminate instead of oscillating.
  const strongOcclusion = occ.height >= OPEN_OCCLUSION_THRESHOLD || overlayProof
  const weakOcclusion = occ.height >= CLOSE_OCCLUSION_THRESHOLD
  const openingSignal = strongOcclusion && (intent || overlayProof)
  const measurable = vv !== null || vkEvidence

  // gap === 0 is not proof of "no keyboard": both viewports can resize together
  // (resize mode with a browser that shrinks the layout viewport too), and a
  // live keyboard rect is evidence even when it overlaps nothing.
  const layoutShrank =
    prev.trustedClosedBaseline !== null && prev.trustedClosedBaseline - layoutH >= CLOSE_OCCLUSION_THRESHOLD
  const ambiguous = !weakOcclusion && (vkEvidence || (intent && layoutShrank))

  let phase: KeyboardPhase = prev.phase
  let pendingHeight = prev.pendingHeight
  let pendingSince = prev.pendingSince
  let phaseSince = prev.phaseSince
  const enter = (next: KeyboardPhase) => {
    if (next !== phase) {
      phase = next
      phaseSince = now
    }
  }

  // Settle: the same candidate on a later sample, or a full settle window with
  // steady geometry. The legacy machine used candidateFrames>=2 || elapsed>=MS
  // for the same reason — the visual viewport animates, so one frame can land
  // mid-animation. Overlay proof needs no settle (it is the API's truth, not a
  // rendered measurement).
  let settled = overlayProof
  if (strongOcclusion) {
    if (pendingHeight === null || Math.abs(occ.height - pendingHeight) > GEOMETRY_TOLERANCE) {
      pendingHeight = occ.height
      pendingSince = now
    } else if (now > pendingSince) {
      settled = true
    }
  } else {
    pendingHeight = null
    pendingSince = 0
  }

  if (!measurable) {
    // Uncertainty stays representable: never coerce to open/closed.
    enter('unknown')
  } else {
    switch (phase) {
      case 'unknown':
        if (openingSignal) enter('opening')
        else if (!weakOcclusion && !ambiguous) enter('closed') // positive closed measurement
        break
      case 'closed':
        if (openingSignal) enter('opening')
        // A weak occlusion without a reason to call it a keyboard is not a
        // closed state either: park in unknown until geometry resolves.
        else if (weakOcclusion || ambiguous) enter('unknown')
        break
      case 'opening':
        // Occlusion vanished before it settled: the open attempt aborted.
        if (!weakOcclusion) enter('closing')
        else if (settled || now - phaseSince >= OPENING_GRACE_MS) enter('open')
        break
      case 'open':
        // Once open, geometry is the authority: a lost focus does not close a
        // still-present keyboard (the textarea keeps focus through a dismiss),
        // but the occlusion dropping below the low threshold does.
        if (!weakOcclusion) enter('closing')
        break
      case 'closing':
        // Re-entering needs sustained strong evidence, not a single weak frame.
        if (openingSignal) enter('opening')
        else if (now - phaseSince >= SETTLE_MS) enter('closed')
        break
    }
    if (phase === 'opening' && overlayProof) enter('open')
  }

  const unobstructed = occ.height <= GEOMETRY_TOLERANCE
  // A large shrink without intent is chrome/stale state, not a new closed
  // baseline — this is the guard the legacy "open latch" assumption lacked.
  const suspiciousShrink =
    prev.trustedClosedBaseline !== null && prev.trustedClosedBaseline - layoutH >= CLOSED_GAP_SUSPICION
  // Invariant: updated only by an unobstructed, intent-free visual viewport
  // measurement in the same envGen (guaranteed above), and never while the
  // platform reports live keyboard geometry — "deducts nothing" is not the same
  // as "no keyboard".
  let trustedClosedBaseline = prev.trustedClosedBaseline
  if (vv !== null && unobstructed && !intent && !suspiciousShrink && !vkEvidence && layoutH > 0) {
    trustedClosedBaseline = layoutH
  }

  // fullLayoutSpace: today's unobstructed measurement, else the trusted
  // baseline, else unknown (null) — never the occluded layout height.
  // An "unobstructed" reading taken while keyboard intent is live is not proof
  // of the full space: in resize mode the layout viewport itself shrinks and
  // the gap still reads zero. Prefer the baseline there.
  const measuredFull =
    vv !== null && layoutH > 0 && unobstructed && !intent && !suspiciousShrink && !vkEvidence ? layoutH : null
  const fullHeight = measuredFull ?? trustedClosedBaseline
  const fullLayoutSpace = fullHeight === null ? null : { width: layoutW, height: fullHeight }

  // visibleRegion: with a visual viewport, only the keyboard band that actually
  // overlaps it is removed. In resize mode vv already excludes the keyboard, so
  // vvOverlap is 0 and nothing is subtracted twice.
  const visibleRegion = vv
    ? { width: clamp0(px(vv.width)), height: clamp0(clamp0(px(vv.height)) - occ.vvOverlap), offsetTop: vvOffsetTop }
    : {
        width: layoutW,
        height: clamp0(layoutH - occ.height),
        offsetTop: occ.height > 0 ? clamp0(layoutH - occ.height) : 0,
      }

  const snapshot: ViewportSnapshot = {
    fullLayoutSpace,
    visibleRegion,
    occlusion: { height: occ.height, trusted: occ.trusted, source: occ.source },
    keyboardPhase: phase,
    envGen,
    measuredAt: now,
  }

  let nextWakeAt: number | null = null
  if (phase === 'opening') {
    // Re-sample until the settle window closes or the opening grace expires.
    const settleDeadline = pendingSince > 0 ? pendingSince + SETTLE_MS : now + SETTLE_MS
    nextWakeAt = Math.max(now + 1, Math.min(settleDeadline, phaseSince + OPENING_GRACE_MS))
  } else if (phase === 'closing') {
    nextWakeAt = Math.max(now + 1, phaseSince + SETTLE_MS)
  } else if (phase === 'unknown' && intent && !weakOcclusion) {
    // Intent without any occlusion yet: poll while a keyboard may be animating
    // in. Once a weak-but-not-strong band is present, waiting for the next
    // event is enough — resampling it would only burn timers.
    nextWakeAt = now + SETTLE_MS
  }

  const nextState: ViewportModelState = {
    phase,
    trustedClosedBaseline,
    pendingHeight: strongOcclusion ? pendingHeight : null,
    pendingSince: strongOcclusion ? pendingSince : 0,
    phaseSince,
    envGen,
  }

  return { state: nextState, snapshot, nextWakeAt }
}
