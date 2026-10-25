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
//   "open latch" assumption) instead of being refreshed unconditionally.
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

type Occlusion = {
  height: number
  trusted: boolean
  source: 'virtual-keyboard' | 'inferred' | 'none'
}

const px = (n: number) => Math.round(n || 0)
const clamp0 = (n: number) => (n > 0 ? n : 0)

// Occlusion is resolved to a single number per snapshot: "deduct once" is a
// structural property, not a caller discipline.
function resolveOcclusion(obs: ViewportObservation, layoutHeight: number): Occlusion {
  const vv = obs.visualViewport
  const vvHeight = vv ? clamp0(px(vv.height)) : null
  const vk = obs.virtualKeyboard
  // rect is only authoritative when the keyboard *overlays* content: with
  // overlaysContent === false the visual viewport already excludes it, so
  // subtracting rect again would count the same occlusion twice.
  const overlayingRect = vk.available && vk.overlaysContent && vk.rect ? vk.rect : null
  const rectHeight = overlayingRect ? clamp0(px(overlayingRect.height)) : 0
  const gap = vvHeight === null ? null : clamp0(layoutHeight - vvHeight)

  if (rectHeight > 0 && gap !== null) {
    return {
      height: Math.max(rectHeight, gap),
      trusted: Math.abs(rectHeight - gap) <= GEOMETRY_TOLERANCE,
      source: 'virtual-keyboard',
    }
  }
  if (rectHeight > 0) return { height: rectHeight, trusted: true, source: 'virtual-keyboard' }
  if (gap !== null && gap > 0) return { height: gap, trusted: false, source: 'inferred' }
  if (gap === null && vk.available && vk.rect) {
    // No visual viewport to measure against: best available signal, flagged
    // untrusted because it cannot be cross-checked.
    return { height: clamp0(px(vk.rect.height)), trusted: false, source: 'inferred' }
  }
  return { height: 0, trusted: false, source: 'none' }
}

export function normalize(state: ViewportModelState, obs: ViewportObservation): NormalizeResult {
  const now = Math.max(0, px(obs.now))
  const envGen = obs.envGen
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

  const layoutW = clamp0(px(obs.layoutViewport.width))
  const layoutH = clamp0(px(obs.layoutViewport.height))
  const vv = obs.visualViewport
  const occ = resolveOcclusion(obs, layoutH)
  const intent = obs.keyboardIntent

  // Evidence and intent are separate axes on purpose.
  // - trusted: the platform handed us a live virtualKeyboard rect.
  // - evidence: geometry shows an occlusion, which may be a keyboard or the
  //   browser chrome; it needs intent to become a keyboard belief.
  const trustedEvidence = occ.trusted && occ.height > 0
  const evidence = occ.height >= OPEN_OCCLUSION_THRESHOLD || trustedEvidence
  const occluded = occ.height >= CLOSE_OCCLUSION_THRESHOLD
  // Entering the open direction needs occlusion *plus* a reason to think it is
  // a keyboard: intent, or an authoritative keyboard rect.
  const openingSignal = occluded && (intent || trustedEvidence)
  // Nothing measurable at all (no visualViewport, no keyboard rect).
  const measurable = vv !== null || trustedEvidence

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
  // mid-animation. Trusted rect geometry needs no settle (it is the API's
  // truth, not a rendered measurement).
  let settled = trustedEvidence
  if (evidence) {
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
        else if (!evidence && !intent) enter('closed') // positive closed measurement
        break
      case 'closed':
        if (openingSignal) enter('opening')
        break
      case 'opening':
        // Occlusion vanished before it settled: the open attempt aborted.
        if (!evidence) enter('closing')
        else if (settled || now - phaseSince >= OPENING_GRACE_MS) enter('open')
        break
      case 'open':
        // Once open, geometry is the authority: a lost focus does not close a
        // still-present keyboard (the textarea keeps focus through a dismiss),
        // but a vanished or weak occlusion does.
        if (!occluded || (!intent && !evidence)) enter('closing')
        break
      case 'closing':
        if (openingSignal) enter('opening')
        else if (now - phaseSince >= SETTLE_MS) enter('closed')
        break
    }
    // Authoritative geometry may short-circuit the opening animation wait
    // (cold start with the keyboard already up).
    if (phase === 'opening' && trustedEvidence) enter('open')
  }

  const unobstructed = occ.height <= GEOMETRY_TOLERANCE
  // A large shrink without intent is chrome/stale state, not a new closed
  // baseline — this is the guard the legacy "open latch" assumption lacked.
  const suspiciousShrink =
    prev.trustedClosedBaseline !== null && prev.trustedClosedBaseline - layoutH >= CLOSED_GAP_SUSPICION
  // Invariant: updated only by an unobstructed visual-viewport measurement in
  // the same envGen (guaranteed by the reset above). Applied layout heights
  // never enter this value.
  let trustedClosedBaseline = prev.trustedClosedBaseline
  if (vv !== null && unobstructed && !intent && !suspiciousShrink && layoutH > 0) {
    trustedClosedBaseline = layoutH
  }

  // fullLayoutSpace: today's unobstructed measurement, else the trusted
  // baseline, else unknown (null) — never the occluded layout height.
  // An "unobstructed" reading taken while keyboard intent is live is not proof
  // of the full space: in resize mode the layout viewport itself shrinks and
  // the gap still reads zero. Prefer the baseline there.
  const measuredFull = vv !== null && layoutH > 0 && unobstructed && !intent && !suspiciousShrink ? layoutH : null
  const fullHeight = measuredFull ?? trustedClosedBaseline
  const fullLayoutSpace = fullHeight === null ? null : { width: layoutW, height: fullHeight }

  // visibleRegion: with a visual viewport, vv already excludes the occlusion —
  // subtracting occ.height here would be the double deduction.
  const visibleRegion = vv
    ? { width: clamp0(px(vv.width)), height: clamp0(px(vv.height)), offsetTop: px(vv.offsetTop) }
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
    nextWakeAt = Math.max(now + 1, Math.min(pendingSince + SETTLE_MS, phaseSince + OPENING_GRACE_MS))
  } else if (phase === 'closing') {
    nextWakeAt = Math.max(now + 1, phaseSince + SETTLE_MS)
  } else if (phase === 'unknown' && intent) {
    // Intent without evidence: poll while a keyboard may still be animating in.
    nextWakeAt = now + SETTLE_MS
  }

  const nextState: ViewportModelState = {
    phase,
    trustedClosedBaseline,
    pendingHeight: evidence ? pendingHeight : null,
    pendingSince: evidence ? pendingSince : 0,
    phaseSince,
    envGen,
  }

  return { state: nextState, snapshot, nextWakeAt }
}
