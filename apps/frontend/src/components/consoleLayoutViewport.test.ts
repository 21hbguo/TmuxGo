import { describe, expect, it } from 'vitest'
import { createViewportStableState, getNextViewportStableState, getViewportLayoutState, normalizeKeyboardViewportState } from './consoleLayoutViewport'

describe('getViewportLayoutState', () => {
  it('uses visual viewport shrink when keyboard resizes viewport', () => {
    expect(getViewportLayoutState({
      isMobileViewport: true,
      innerHeight: 800,
      viewportHeight: 520,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: 800,
      keyboardOpen: true,
      keyboardInset: 0,
      bodyKeyboardOpen: true,
    })).toEqual({
      viewportWidth: 390,
      baseHeight: 800,
      inset: 280,
      open: true,
      nextHeight: 520,
    })
  })
  it('uses keyboard inset when keyboard overlays content', () => {
    expect(getViewportLayoutState({
      isMobileViewport: true,
      innerHeight: 800,
      viewportHeight: 800,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: 800,
      keyboardOpen: true,
      keyboardInset: 280,
      bodyKeyboardOpen: true,
    })).toEqual({
      viewportWidth: 390,
      baseHeight: 800,
      inset: 280,
      open: true,
      nextHeight: 520,
    })
  })
  it('keeps full height when keyboard is closed', () => {
    expect(getViewportLayoutState({
      isMobileViewport: true,
      innerHeight: 800,
      viewportHeight: 800,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: 800,
      keyboardOpen: false,
      keyboardInset: 0,
      bodyKeyboardOpen: false,
    })).toEqual({
      viewportWidth: 390,
      baseHeight: 800,
      inset: 0,
      open: false,
      nextHeight: 800,
    })
  })
  it('uses visual viewport when keyboard is closed and shrink is small', () => {
    expect(getViewportLayoutState({
      isMobileViewport: true,
      innerHeight: 844,
      viewportHeight: 760,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: 844,
      keyboardOpen: false,
      keyboardInset: 0,
      bodyKeyboardOpen: false,
    })).toEqual({
      viewportWidth: 390,
      baseHeight: 844,
      inset: 0,
      open: false,
      nextHeight: 760,
    })
  })
  it('ignores focused editable viewport shrink until keyboard state is confirmed', () => {
    expect(getViewportLayoutState({
      isMobileViewport: true,
      innerHeight: 800,
      viewportHeight: 520,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: 800,
      keyboardOpen: false,
      keyboardInset: 0,
      bodyKeyboardOpen: false,
    })).toEqual({
      viewportWidth: 390,
      baseHeight: 800,
      inset: 0,
      open: false,
      nextHeight: 800,
    })
  })
  it('does not use stale keyboard inset when visual viewport already resized', () => {
    expect(getViewportLayoutState({
      isMobileViewport: true,
      innerHeight: 725,
      viewportHeight: 448,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: 670,
      keyboardOpen: true,
      keyboardInset: 277,
      bodyKeyboardOpen: true,
    })).toEqual({
      viewportWidth: 390,
      baseHeight: 670,
      inset: 222,
      open: true,
      nextHeight: 448,
    })
  })
  it('rejects keyboard-close overshoot and settles back to the previous closed height', () => {
    let stable = createViewportStableState(670)
    let baseHeight = 670
    const sample = (viewportHeight: number, keyboardOpen: boolean, keyboardInset: number, now: number) => {
      stable = getNextViewportStableState({
        state: stable,
        isMobileViewport: true,
        innerHeight: viewportHeight,
        viewportHeight,
        viewportWidth: 390,
        previousViewportWidth: 390,
        baseHeight,
        keyboardOpen,
        bodyKeyboardOpen: keyboardOpen,
        currentAppHeight: baseHeight,
        now,
      })
      const layout = getViewportLayoutState({
        isMobileViewport: true,
        innerHeight: viewportHeight,
        viewportHeight,
        viewportWidth: 390,
        previousViewportWidth: 390,
        baseHeight: stable.stableClosedHeight,
        keyboardOpen,
        keyboardInset,
        bodyKeyboardOpen: keyboardOpen,
      })
      baseHeight = layout.baseHeight
      return layout
    }
    expect(sample(670, false, 0, 0).nextHeight).toBe(670)
    expect(sample(448, true, 222, 16).nextHeight).toBe(448)
    expect(sample(393, true, 277, 32).nextHeight).toBe(393)
    const overshoot = sample(725, false, 0, 48)
    expect(overshoot.nextHeight).toBe(670)
    expect(overshoot.nextHeight).not.toBe(725)
    expect(sample(670, false, 0, 64).nextHeight).toBe(670)
    expect(stable.stableClosedHeight).toBe(670)
  })
  it('waits before accepting a large viewport after keyboard-open class is removed', () => {
    let stable = { ...createViewportStableState(670), wasOpen: true }
    stable = getNextViewportStableState({
      state: stable,
      isMobileViewport: true,
      innerHeight: 725,
      viewportHeight: 725,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: 670,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      currentAppHeight: 393,
      now: 100,
    })
    expect(stable.stableClosedHeight).toBe(670)
    stable = getNextViewportStableState({
      state: stable,
      isMobileViewport: true,
      innerHeight: 725,
      viewportHeight: 725,
      viewportWidth: 390,
      previousViewportWidth: 390,
      baseHeight: stable.stableClosedHeight,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      currentAppHeight: 670,
      now: 430,
    })
    expect(stable.stableClosedHeight).toBe(725)
  })
})
describe('normalizeKeyboardViewportState', () => {
  it('closes stale keyboard state when body class is not open and owner is inactive', () => {
    expect(normalizeKeyboardViewportState({
      keyboardOpen: true,
      keyboardInset: 280,
      bodyKeyboardOpen: false,
      keyboardOwnerActive: false,
    })).toEqual({ keyboardOpen: false, keyboardInset: 0 })
  })
  it('keeps keyboard state when owner is active', () => {
    expect(normalizeKeyboardViewportState({
      keyboardOpen: true,
      keyboardInset: 280,
      bodyKeyboardOpen: false,
      keyboardOwnerActive: true,
    })).toEqual({ keyboardOpen: true, keyboardInset: 280 })
  })
  it('keeps keyboard state when body class reports open', () => {
    expect(normalizeKeyboardViewportState({
      keyboardOpen: true,
      keyboardInset: 280,
      bodyKeyboardOpen: true,
      keyboardOwnerActive: false,
    })).toEqual({ keyboardOpen: true, keyboardInset: 280 })
  })
})
