import { describe, expect, it } from 'vitest'
import { getViewportLayoutState, normalizeKeyboardViewportState } from './consoleLayoutViewport'

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
