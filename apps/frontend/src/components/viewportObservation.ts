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

export function readOrientation(): ViewportObservation['orientation'] {
  // Geometry-based: inner dims swap on rotation, and jsdom has no matchMedia.
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
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
    orientation: readOrientation(),
    fullscreen: readFullscreen(),
    envGen: ctx.envGen ?? 0,
  }
}

// Layout-environment identity: only these fields invalidate a baseline.
export type ViewportEnv = {
  width: number
  orientation: ViewportObservation['orientation']
  fullscreen: boolean
}

export function readViewportEnv(): ViewportEnv {
  return { width: window.innerWidth, orientation: readOrientation(), fullscreen: readFullscreen() }
}

// Pure tracker: callers feed it the current env (readViewportEnv() or their own
// probe). The generation bumps only on width/orientation/fullscreen changes;
// the first observation establishes the baseline without bumping.
export class ViewportEnvTracker {
  private gen: number
  private env: ViewportEnv | null = null

  constructor(initialGen = 0) {
    this.gen = initialGen
  }

  get envGen(): number {
    return this.gen
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
    return this.gen
  }

  // observe + track in one step for wiring convenience.
  sync(env: ViewportEnv = readViewportEnv()): number {
    return this.update(env)
  }

  reset(initialGen = 0): void {
    this.gen = initialGen
    this.env = null
  }
}
