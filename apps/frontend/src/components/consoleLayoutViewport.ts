const VIEWPORT_SETTLE_MS = 320
const VIEWPORT_OVERSHOOT_THRESHOLD = 36
const CLOSED_VIEWPORT_GAP = 120
const KEYBOARD_RESIZE_INSET_THRESHOLD = 120
const VIEWPORT_STABLE_TOLERANCE = 1
export type ViewportStableState = {
  stableClosedHeight: number
  candidateClosedHeight: number
  candidateSince: number
  candidateFrames: number
  closedSince: number
  wasOpen: boolean
}
export function createViewportStableState(stableClosedHeight = 0): ViewportStableState {
  return {
    stableClosedHeight: Math.round(stableClosedHeight || 0),
    candidateClosedHeight: 0,
    candidateSince: 0,
    candidateFrames: 0,
    closedSince: 0,
    wasOpen: false,
  }
}
export function normalizeKeyboardViewportState({
  keyboardOpen,
  keyboardInset,
  bodyKeyboardOpen,
  keyboardOwnerActive,
}: {
  keyboardOpen: boolean
  keyboardInset: number
  bodyKeyboardOpen: boolean
  keyboardOwnerActive: boolean
}) {
  if (!bodyKeyboardOpen && keyboardOpen && !keyboardOwnerActive) return { keyboardOpen: false, keyboardInset: 0 }
  return { keyboardOpen, keyboardInset }
}
export function getNextViewportStableState({
  state,
  isMobileViewport,
  innerHeight,
  viewportHeight,
  viewportWidth,
  previousViewportWidth,
  baseHeight,
  keyboardOpen,
  bodyKeyboardOpen,
  currentAppHeight = 0,
  now = 0,
}: {
  state: ViewportStableState
  isMobileViewport: boolean
  innerHeight: number
  viewportHeight: number
  viewportWidth: number
  previousViewportWidth: number
  baseHeight: number
  keyboardOpen: boolean
  bodyKeyboardOpen: boolean
  currentAppHeight?: number
  now?: number
}) {
  const nextViewportWidth = Math.round(viewportWidth || 0)
  const widthChanged = previousViewportWidth !== nextViewportWidth
  const observedHeight = Math.round(viewportHeight || innerHeight || 0)
  const fallbackHeight = Math.round(baseHeight || observedHeight || innerHeight || 0)
  const open = isMobileViewport && (keyboardOpen || bodyKeyboardOpen)
  if (!isMobileViewport) return createViewportStableState(Math.round(innerHeight || observedHeight || fallbackHeight || 0))
  if (widthChanged) {
    const stableClosedHeight = open ? Math.round(baseHeight || currentAppHeight || innerHeight || observedHeight || 0) : observedHeight || fallbackHeight
    return { ...createViewportStableState(stableClosedHeight), wasOpen: open }
  }
  const stableClosedHeight = Math.round(state.stableClosedHeight || baseHeight || (!open ? observedHeight : fallbackHeight) || 0)
  if (open) {
    const openingHeight = !state.wasOpen ? Math.round(currentAppHeight || 0) : 0
    return { stableClosedHeight: openingHeight || stableClosedHeight, candidateClosedHeight: 0, candidateSince: 0, candidateFrames: 0, closedSince: 0, wasOpen: true }
  }
  const closedSince = state.wasOpen ? now : state.closedSince
  if (!observedHeight) return { ...state, stableClosedHeight, closedSince, wasOpen: false }
  const candidateChanged = Math.abs(observedHeight - state.candidateClosedHeight) > VIEWPORT_STABLE_TOLERANCE
  const candidateClosedHeight = candidateChanged ? observedHeight : state.candidateClosedHeight
  const candidateSince = candidateChanged ? now : state.candidateSince
  const candidateFrames = candidateChanged ? 1 : state.candidateFrames + 1
  const candidateSettled = candidateFrames >= 2 || now - candidateSince >= VIEWPORT_SETTLE_MS
  const largeShrink = stableClosedHeight > 0 && stableClosedHeight - observedHeight >= CLOSED_VIEWPORT_GAP
  const closingOvershoot = stableClosedHeight > 0 && observedHeight - stableClosedHeight > VIEWPORT_OVERSHOOT_THRESHOLD && closedSince > 0 && now - closedSince < VIEWPORT_SETTLE_MS
  const nextStableClosedHeight = !stableClosedHeight ? observedHeight : !largeShrink && candidateSettled && !closingOvershoot ? observedHeight : stableClosedHeight
  return { stableClosedHeight: nextStableClosedHeight, candidateClosedHeight, candidateSince, candidateFrames, closedSince, wasOpen: false }
}
export function getViewportLayoutState({
  isMobileViewport,
  innerHeight,
  viewportHeight,
  viewportWidth,
  previousViewportWidth,
  baseHeight,
  keyboardOpen,
  keyboardInset,
  bodyKeyboardOpen,
}: {
  isMobileViewport: boolean
  innerHeight: number
  viewportHeight: number
  viewportWidth: number
  previousViewportWidth: number
  baseHeight: number
  keyboardOpen: boolean
  keyboardInset: number
  bodyKeyboardOpen: boolean
}) {
  const nextViewportWidth = Math.round(viewportWidth || 0)
  const widthChanged = previousViewportWidth !== nextViewportWidth
  let nextBaseHeight = widthChanged ? 0 : Math.round(baseHeight || 0)
  if (!nextBaseHeight) nextBaseHeight = Math.round(viewportHeight || innerHeight || 0)
  const resolvedBaseHeight = nextBaseHeight || viewportHeight || innerHeight
  const viewportInset = viewportHeight ? Math.max(0, resolvedBaseHeight - viewportHeight) : 0
  const effectiveInset = viewportInset >= KEYBOARD_RESIZE_INSET_THRESHOLD ? viewportInset : Math.max(viewportInset, keyboardOpen ? keyboardInset : 0)
  const open = isMobileViewport && (keyboardOpen || bodyKeyboardOpen)
  const closedViewportGap = viewportHeight ? Math.max(0, resolvedBaseHeight - viewportHeight) : 0
  const closedHeight = isMobileViewport && viewportHeight && closedViewportGap > 0 && closedViewportGap < CLOSED_VIEWPORT_GAP ? viewportHeight : resolvedBaseHeight
  const nextHeight = Math.round(!isMobileViewport ? innerHeight : open ? Math.max(0, resolvedBaseHeight - effectiveInset) : closedHeight)
  return { viewportWidth: nextViewportWidth, baseHeight: nextBaseHeight, inset: open ? effectiveInset : 0, open, nextHeight }
}
