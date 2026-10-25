// Unified viewport observation sampler — stage 1 input side of the viewport
// state machine. One call produces the complete ViewportObservation from
// browser signals; no interpretation, no timers, no React.
//
// Design rules (see notes/dispatch-2026-10-25/viewport/design.md):
// - Absence of an API is represented as null, never as a measured zero.
// - Event-shaped/volatile inputs (now, composition) are injected through ctx so
//   the sampler stays deterministic and testable.
// - envGen is owned by ViewportEnvTracker; observations from an older gen must
//   not feed baselines (contract invariant 1).
import type { Rect, ViewportObservation } from './viewportContract'

// navigator.virtualKeyboard is Android Chrome-only and not in the DOM lib.
type VirtualKeyboardLike = {
  overlaysContent?: boolean
  boundingRect?: { x?: number; y?: number; width?: number; height?: number } | null
}

const KEYBOARD_INTENT_CLASS = 'mobile-kb-input'
const KEYBOARD_INTENT_ATTR = 'data-keyboard-intent'
const TERMINAL_FOCUS_SELECTOR = '[data-terminal],.xterm,.xterm-screen'

// Text-rewritten inputmodes that clearly do not expect an on-screen keyboard.
const NON_KEYBOARD_INPUTMODES = new Set(['none'])

export type ViewportObservationContext = {
  now: number
  composition: boolean
  // Generation from ViewportEnvTracker at sample time; defaults to 0.
  envGen?: number
  // Orientation resolved by ViewportEnvTracker (which can freeze it while an
  // occlusion is present). Falls back to a stateless read when absent.
  orientation?: ViewportObservation['orientation']
}

function getVirtualKeyboard(): VirtualKeyboardLike | undefined {
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard
}

function toRect(source: NonNullable<VirtualKeyboardLike['boundingRect']>): Rect {
  // Older Android implementations expose only height; missing axes default to 0.
  return {
    x: source.x ?? 0,
    y: source.y ?? 0,
    width: source.width ?? 0,
    height: source.height ?? 0,
  }
}

export function readLayoutViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

// null = visualViewport API absent (distinct from a zero-sized viewport).
export function readVisualViewport(): ViewportObservation['visualViewport'] {
  const vv = window.visualViewport
  if (!vv) return null
  return {
    width: vv.width,
    height: vv.height,
    offsetTop: vv.offsetTop,
    offsetLeft: vv.offsetLeft,
    scale: vv.scale,
  }
}

export function readVirtualKeyboard(): ViewportObservation['virtualKeyboard'] {
  const virtualKeyboard = getVirtualKeyboard()
  if (!virtualKeyboard) return { available: false, overlaysContent: false, rect: null }
  const overlaysContent = virtualKeyboard.overlaysContent === true
  const boundingRect = virtualKeyboard.boundingRect
  // A zero-height boundingRect means "keyboard not visible" — report null so
  // consumers can distinguish "hidden" from "measured 0".
  const rect = boundingRect && (boundingRect.height ?? 0) > 0 ? toRect(boundingRect) : null
  return { available: true, overlaysContent, rect }
}

function hasKeyboardIntent(el: HTMLElement): boolean {
  // Only explicit author markers count; a bare focus must not prove intent.
  if (el.classList.contains(KEYBOARD_INTENT_CLASS)) return true
  if (el.getAttribute(KEYBOARD_INTENT_ATTR) === 'true') return true
  const inputMode = el.getAttribute('inputmode')
  if (inputMode && !NON_KEYBOARD_INPUTMODES.has(inputMode)) return true
  return false
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function readInputOwner(): {
  inputOwner: ViewportObservation['inputOwner']
  keyboardIntent: boolean
} {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body || active === document.documentElement)
    return { inputOwner: 'none', keyboardIntent: false }
  // Terminal-owned focus: the hidden mobile textarea or anything inside xterm.
  if (active.classList.contains(KEYBOARD_INTENT_CLASS) || active.closest(TERMINAL_FOCUS_SELECTOR))
    return { inputOwner: 'terminal', keyboardIntent: hasKeyboardIntent(active) }
  if (isEditable(active)) return { inputOwner: 'overlay', keyboardIntent: hasKeyboardIntent(active) }
  return { inputOwner: 'none', keyboardIntent: false }
}

export type ViewportOrientation = ViewportObservation['orientation']

// A layout viewport shorter by at least this much than the visual viewport's
// available height is keyboard-sized occlusion, not browser chrome (same order
// as the legacy keyboard-open threshold of 70px).
export const ORIENTATION_FREEZE_INSET_PX = 70

function readScreenOrientationType(): string | null {
  // screen.orientation is not part of the jsdom DOM lib; treat it as optional.
  const orientation = (screen as Screen & { orientation?: { type?: string } }).orientation
  return typeof orientation?.type === 'string' ? orientation.type : null
}

function orientationFromScreenType(type: string | null): ViewportOrientation | null {
  if (!type) return null
  if (type.startsWith('portrait')) return 'portrait'
  if (type.startsWith('landscape')) return 'landscape'
  return null
}

// Keyboard-height evidence. The keyboard collapses the visual viewport (or
// reports a visible virtual-keyboard rect) and/or holds an explicit input
// intent; none of these can change the width.
export function hasKeyboardOcclusionEvidence(): boolean {
  const keyboard = readVirtualKeyboard()
  if (keyboard.rect && keyboard.rect.height > 0) return true
  const vv = readVisualViewport()
  if (vv && window.innerHeight - vv.height >= ORIENTATION_FREEZE_INSET_PX) return true
  return readInputOwner().keyboardIntent
}

// Environment identity must never be derived from a dimension the keyboard can
// collapse. Precedence: screen.orientation (authoritative, keyboard-independent)
// → frozen previous value when it cannot be a rotation (a rotation always
// changes the viewport width, a keyboard never does; with no previous width,
// occlusion evidence is enough) → raw aspect ratio as last resort.
export function resolveOrientation(
  signals: { width: number; height: number; screenType: string | null; occluded: boolean },
  previous: ViewportOrientation | null,
  previousWidth: number | null,
): ViewportOrientation {
  const fromScreen = orientationFromScreenType(signals.screenType)
  if (fromScreen) return fromScreen
  if (previous) {
    if (previousWidth === null) {
      if (signals.occluded) return previous
    } else if (Math.round(previousWidth) === Math.round(signals.width)) {
      return previous
    }
  }
  return signals.width > signals.height ? 'landscape' : 'portrait'
}

// Stateless best effort (screen API first). Callers that can see occlusions
// should use ViewportEnvTracker.sync(), which freezes the value instead.
export function readOrientation(): ViewportOrientation {
  return resolveOrientation(
    { width: window.innerWidth, height: window.innerHeight, screenType: readScreenOrientationType(), occluded: false },
    null,
    null,
  )
}

export function readFullscreen(): boolean {
  // Two fullscreen notions coexist: real Fullscreen API and the immersive
  // layout flag toggled by usePreferences (data-immersive-fullscreen).
  if (document.fullscreenElement) return true
  return document.documentElement.hasAttribute('data-immersive-fullscreen')
}

// One sample per tick; events only trigger resampling.
export function sampleViewportObservation(ctx: ViewportObservationContext): ViewportObservation {
  const { inputOwner, keyboardIntent } = readInputOwner()
  return {
    now: ctx.now,
    layoutViewport: readLayoutViewport(),
    visualViewport: readVisualViewport(),
    virtualKeyboard: readVirtualKeyboard(),
    inputOwner,
    keyboardIntent,
    composition: ctx.composition,
    orientation: ctx.orientation ?? readOrientation(),
    fullscreen: readFullscreen(),
    envGen: ctx.envGen ?? 0,
  }
}

// Layout-environment identity: only these fields invalidate a baseline.
export type ViewportEnv = {
  width: number
  orientation: ViewportOrientation
  fullscreen: boolean
}

// Raw signals for env resolution (orientation not yet decided).
export type ViewportEnvSignals = {
  width: number
  height: number
  screenType: string | null
  fullscreen: boolean
  occluded: boolean
}

export function readViewportEnvSignals(): ViewportEnvSignals {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    screenType: readScreenOrientationType(),
    fullscreen: readFullscreen(),
    occluded: hasKeyboardOcclusionEvidence(),
  }
}

export function readViewportEnv(): ViewportEnv {
  const signals = readViewportEnvSignals()
  return {
    width: signals.width,
    orientation: resolveOrientation(signals, null, null),
    fullscreen: signals.fullscreen,
  }
}

// Pure tracker: callers feed it the current env (readViewportEnv() or their own
// probe). The generation bumps only on width/orientation/fullscreen changes;
// the first observation establishes the baseline without bumping. Height-only
// keyboard collapse changes neither, so it cannot forge an env switch.
export class ViewportEnvTracker {
  private gen: number
  private env: ViewportEnv | null = null
  private orientation: ViewportOrientation | null = null

  constructor(initialGen = 0) {
    this.gen = initialGen
  }

  get envGen(): number {
    return this.gen
  }

  // Last resolved orientation (frozen across occlusions), for reuse by the
  // observation sampler so both agree on one env identity.
  get resolvedOrientation(): ViewportOrientation | null {
    return this.orientation
  }

  update(env: ViewportEnv): number {
    // Round: subpixel layout jitter must not invalidate baselines.
    const next: ViewportEnv = { width: Math.round(env.width), orientation: env.orientation, fullscreen: env.fullscreen }
    const prev = this.env
    if (
      prev &&
      (prev.width !== next.width || prev.orientation !== next.orientation || prev.fullscreen !== next.fullscreen)
    )
      this.gen += 1
    this.env = next
    this.orientation = next.orientation
    return this.gen
  }

  // observe + track in one step for wiring convenience; resolves orientation
  // with occlusion-aware freezing before bumping the generation.
  sync(signals: ViewportEnvSignals = readViewportEnvSignals()): number {
    const previousWidth = this.env?.width ?? null
    this.orientation = resolveOrientation(signals, this.orientation, previousWidth)
    return this.update({ width: signals.width, orientation: this.orientation, fullscreen: signals.fullscreen })
  }

  reset(initialGen = 0): void {
    this.gen = initialGen
    this.env = null
    this.orientation = null
  }
}
