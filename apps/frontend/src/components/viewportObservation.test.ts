import { afterEach, describe, expect, it } from 'vitest'
import type { Rect } from './viewportContract'
import {
  hasKeyboardOcclusionEvidence,
  sampleViewportObservation,
  ViewportEnvTracker,
  type ViewportObservationContext,
} from './viewportObservation'

const ctx = (over: Partial<ViewportObservationContext> = {}): ViewportObservationContext => ({
  now: 1000,
  composition: false,
  envGen: 0,
  ...over,
})

function setWindowSize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

function setVisualViewport(vv: {
  width: number
  height: number
  offsetTop?: number
  offsetLeft?: number
  scale?: number
}) {
  Object.defineProperty(window, 'visualViewport', {
    value: {
      width: vv.width,
      height: vv.height,
      offsetTop: vv.offsetTop ?? 0,
      offsetLeft: vv.offsetLeft ?? 0,
      scale: vv.scale ?? 1,
    },
    configurable: true,
  })
}

function setVirtualKeyboard(kb: { overlaysContent?: boolean; boundingRect?: Partial<Rect> | null } | undefined) {
  Object.defineProperty(navigator, 'virtualKeyboard', { value: kb, configurable: true })
}

function focusElement(el: HTMLElement) {
  document.body.appendChild(el)
  el.focus()
  return el
}

function createElement(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  const el = host.firstElementChild as HTMLElement
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-immersive-fullscreen')
  setWindowSize(390, 800)
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
  setVirtualKeyboard(undefined)
  // jsdom keeps activeElement on the removed node; reset to body.
  ;(document.activeElement as HTMLElement | null)?.blur?.()
})

describe('sampleViewportObservation', () => {
  it('reports visualViewport null when the API is absent', () => {
    setWindowSize(390, 800)
    expect(sampleViewportObservation(ctx()).visualViewport).toBeNull()
  })

  it('samples visual viewport geometry including offsets and scale', () => {
    setVisualViewport({ width: 390, height: 446, offsetTop: 34, offsetLeft: 0, scale: 1.5 })
    expect(sampleViewportObservation(ctx()).visualViewport).toEqual({
      width: 390,
      height: 446,
      offsetTop: 34,
      offsetLeft: 0,
      scale: 1.5,
    })
  })

  it('reports virtualKeyboard unavailable when navigator API is missing', () => {
    expect(sampleViewportObservation(ctx()).virtualKeyboard).toEqual({
      available: false,
      overlaysContent: false,
      rect: null,
    })
  })

  it('takes keyboard geometry from boundingRect when overlaysContent=true', () => {
    setVirtualKeyboard({ overlaysContent: true, boundingRect: { x: 0, y: 500, width: 390, height: 300 } })
    expect(sampleViewportObservation(ctx()).virtualKeyboard).toEqual({
      available: true,
      overlaysContent: true,
      rect: { x: 0, y: 500, width: 390, height: 300 },
    })
  })

  it('keeps overlaysContent=false and still exposes rect when the keyboard reports geometry', () => {
    setVirtualKeyboard({ overlaysContent: false, boundingRect: { height: 280 } })
    expect(sampleViewportObservation(ctx()).virtualKeyboard).toEqual({
      available: true,
      overlaysContent: false,
      rect: { x: 0, y: 0, width: 0, height: 280 },
    })
  })

  it('reports rect null (not zero-height rect) when the keyboard is hidden', () => {
    setVirtualKeyboard({ overlaysContent: true, boundingRect: { x: 0, y: 800, width: 390, height: 0 } })
    expect(sampleViewportObservation(ctx()).virtualKeyboard.rect).toBeNull()
    setVirtualKeyboard({ overlaysContent: true, boundingRect: null })
    expect(sampleViewportObservation(ctx()).virtualKeyboard.rect).toBeNull()
  })

  it('passes now, composition and envGen through unchanged', () => {
    const observation = sampleViewportObservation(ctx({ now: 4242, composition: true, envGen: 7 }))
    expect(observation.now).toBe(4242)
    expect(observation.composition).toBe(true)
    expect(observation.envGen).toBe(7)
  })

  it('derives orientation from layout geometry and fullscreen from the document', () => {
    setWindowSize(800, 390)
    expect(sampleViewportObservation(ctx()).orientation).toBe('landscape')
    setWindowSize(390, 800)
    expect(sampleViewportObservation(ctx()).orientation).toBe('portrait')
    expect(sampleViewportObservation(ctx()).fullscreen).toBe(false)
    document.documentElement.setAttribute('data-immersive-fullscreen', '')
    expect(sampleViewportObservation(ctx()).fullscreen).toBe(true)
  })

  it('reports owner none and no intent when nothing is focused', () => {
    const observation = sampleViewportObservation(ctx())
    expect(observation.inputOwner).toBe('none')
    expect(observation.keyboardIntent).toBe(false)
  })

  it('does not mark intent for a focused button (mis-tagging guard)', () => {
    focusElement(createElement('<button>ok</button>'))
    const observation = sampleViewportObservation(ctx())
    expect(observation.inputOwner).toBe('none')
    expect(observation.keyboardIntent).toBe(false)
  })

  it('does not mark intent for a plain focused input without an explicit marker', () => {
    focusElement(createElement('<input type="text" />'))
    const observation = sampleViewportObservation(ctx())
    expect(observation.inputOwner).toBe('overlay')
    expect(observation.keyboardIntent).toBe(false)
  })

  it('treats the mobile keyboard textarea as terminal-owned with intent', () => {
    focusElement(createElement('<textarea class="mobile-kb-input"></textarea>'))
    const observation = sampleViewportObservation(ctx())
    expect(observation.inputOwner).toBe('terminal')
    expect(observation.keyboardIntent).toBe(true)
  })

  it('treats focus inside the terminal as terminal-owned without intent', () => {
    const host = createElement('<div data-terminal><textarea></textarea></div>')
    ;(host.querySelector('textarea') as HTMLTextAreaElement).focus()
    const observation = sampleViewportObservation(ctx())
    expect(observation.inputOwner).toBe('terminal')
    expect(observation.keyboardIntent).toBe(false)
  })

  it('honours explicit intent markers and ignores inputmode=none', () => {
    focusElement(createElement('<input inputmode="text" />'))
    expect(sampleViewportObservation(ctx()).keyboardIntent).toBe(true)
    document.body.innerHTML = ''
    focusElement(createElement('<input inputmode="none" />'))
    expect(sampleViewportObservation(ctx()).keyboardIntent).toBe(false)
    document.body.innerHTML = ''
    focusElement(createElement('<textarea data-keyboard-intent="true"></textarea>'))
    expect(sampleViewportObservation(ctx()).keyboardIntent).toBe(true)
  })
})

describe('ViewportEnvTracker', () => {
  it('does not bump on the first observation', () => {
    const tracker = new ViewportEnvTracker()
    expect(tracker.update({ width: 390, orientation: 'portrait', fullscreen: false })).toBe(0)
    expect(tracker.envGen).toBe(0)
  })

  it('bumps on width, orientation and fullscreen changes only', () => {
    const tracker = new ViewportEnvTracker()
    tracker.update({ width: 390, orientation: 'portrait', fullscreen: false })
    expect(tracker.update({ width: 390, orientation: 'portrait', fullscreen: false })).toBe(0)
    expect(tracker.update({ width: 844, orientation: 'landscape', fullscreen: false })).toBe(1)
    expect(tracker.update({ width: 844, orientation: 'landscape', fullscreen: true })).toBe(2)
    // Height-only (keyboard) changes are not env changes: width is the only size input.
    expect(tracker.update({ width: 844, orientation: 'landscape', fullscreen: true })).toBe(2)
  })

  it('ignores subpixel width jitter', () => {
    const tracker = new ViewportEnvTracker()
    tracker.update({ width: 390, orientation: 'portrait', fullscreen: false })
    expect(tracker.update({ width: 390.4, orientation: 'portrait', fullscreen: false })).toBe(0)
  })

  it('sync reads the live environment and can be reset', () => {
    setWindowSize(390, 800)
    const tracker = new ViewportEnvTracker()
    expect(tracker.sync()).toBe(0)
    setWindowSize(844, 390)
    expect(tracker.sync()).toBe(1)
    tracker.reset()
    expect(tracker.envGen).toBe(0)
    expect(tracker.sync()).toBe(0)
  })
})

// --- F2: env identity must not be derived from keyboard-collapsible height ---
function setScreenOrientationType(type: string | undefined) {
  Object.defineProperty(screen, 'orientation', { value: type ? { type } : undefined, configurable: true })
}

afterEach(() => {
  setScreenOrientationType(undefined)
})

describe('env identity vs keyboard height', () => {
  it('does not forge an env switch when the keyboard collapses innerHeight only', () => {
    setWindowSize(390, 800)
    setVisualViewport({ width: 390, height: 800 })
    const tracker = new ViewportEnvTracker()
    expect(tracker.sync()).toBe(0)
    // Chrome-style resize: keyboard shrinks the layout viewport too (800 → 300).
    setWindowSize(390, 300)
    setVisualViewport({ width: 390, height: 300 })
    expect(tracker.sync()).toBe(0)
    expect(tracker.resolvedOrientation).toBe('portrait')
  })

  it('still detects a real rotation while the keyboard is up', () => {
    setWindowSize(390, 800)
    setVisualViewport({ width: 390, height: 800 })
    const tracker = new ViewportEnvTracker()
    expect(tracker.sync()).toBe(0)
    // Rotation: width changes, height shrinks and stays occluded.
    setWindowSize(844, 390)
    setVisualViewport({ width: 844, height: 200 })
    expect(tracker.sync()).toBe(1)
    expect(tracker.resolvedOrientation).toBe('landscape')
    expect(tracker.envGen).toBe(1)
  })

  it('prefers screen.orientation over the aspect ratio', () => {
    setWindowSize(800, 390)
    setVisualViewport({ width: 800, height: 390 })
    setScreenOrientationType('portrait-primary')
    const tracker = new ViewportEnvTracker()
    expect(tracker.sync()).toBe(0)
    expect(tracker.resolvedOrientation).toBe('portrait')
    // Height collapse must not change it while the screen still reports portrait.
    setWindowSize(800, 200)
    setVisualViewport({ width: 800, height: 200 })
    expect(tracker.sync()).toBe(0)
    expect(tracker.resolvedOrientation).toBe('portrait')
  })

  it('resolution helpers report keyboard occlusion evidence', () => {
    setWindowSize(390, 800)
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    expect(hasKeyboardOcclusionEvidence()).toBe(false)
    setVisualViewport({ width: 390, height: 500 })
    expect(hasKeyboardOcclusionEvidence()).toBe(true)
    setVisualViewport({ width: 390, height: 780 })
    expect(hasKeyboardOcclusionEvidence()).toBe(false)
    setVirtualKeyboard({ overlaysContent: true, boundingRect: { height: 300 } })
    expect(hasKeyboardOcclusionEvidence()).toBe(true)
  })

  it('lets the injected tracker orientation win over the stateless read', () => {
    setWindowSize(800, 390)
    expect(sampleViewportObservation(ctx({ orientation: 'portrait' })).orientation).toBe('portrait')
    expect(sampleViewportObservation(ctx()).orientation).toBe('landscape')
  })

  it('reads orientation from screen.orientation in the stateless path', () => {
    setWindowSize(800, 390)
    setScreenOrientationType('portrait-secondary')
    expect(sampleViewportObservation(ctx()).orientation).toBe('portrait')
  })
})
