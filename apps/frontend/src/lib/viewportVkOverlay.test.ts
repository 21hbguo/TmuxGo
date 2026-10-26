import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyVkOverlay,
  createVkGeometrySampler,
  estimateVkBottom,
  isVkOverlayActive,
  isVkOverlayRequested,
  readVkRect,
  UrlbarCalibrator,
} from './viewportVkOverlay'

type FakeVk = {
  overlaysContent?: boolean
  boundingRect?: { x?: number; y?: number; width?: number; height?: number; top?: number; bottom?: number } | null
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

function installVk(vk: FakeVk | undefined): void {
  Object.defineProperty(navigator, 'virtualKeyboard', { value: vk, configurable: true, writable: true })
}

function storage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'virtualKeyboard')
  window.localStorage.removeItem('tmuxgo-vk-overlay')
  delete (window as typeof window & { __tmuxgoMobileDiagnostics?: unknown }).__tmuxgoMobileDiagnostics
  vi.restoreAllMocks()
})

describe('isVkOverlayRequested', () => {
  it('accepts the query parameter', () => {
    expect(isVkOverlayRequested('?vk-overlay=1', storage())).toBe(true)
    expect(isVkOverlayRequested('?foo=1&vk-overlay=1', storage())).toBe(true)
  })

  it('accepts the localStorage flag', () => {
    expect(isVkOverlayRequested('', storage({ 'tmuxgo-vk-overlay': '1' }))).toBe(true)
    expect(isVkOverlayRequested('', storage({ 'tmuxgo-vk-overlay': '0' }))).toBe(false)
  })

  it('defaults to off', () => {
    expect(isVkOverlayRequested('', storage())).toBe(false)
    expect(isVkOverlayRequested(undefined, storage())).toBe(false)
  })

  it('treats blocked storage as off instead of throwing', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage
    expect(isVkOverlayRequested('', broken)).toBe(false)
  })
})

describe('applyVkOverlay', () => {
  it('turns overlaysContent on and restores the previous value', () => {
    installVk({ overlaysContent: false })
    const restore = applyVkOverlay(true)
    expect(isVkOverlayActive()).toBe(true)
    restore()
    expect(isVkOverlayActive()).toBe(false)
  })

  it('removes the property when it did not exist before', () => {
    const vk: FakeVk = {}
    installVk(vk)
    const restore = applyVkOverlay(true)
    expect(vk.overlaysContent).toBe(true)
    restore()
    expect(Object.prototype.hasOwnProperty.call(vk, 'overlaysContent')).toBe(false)
  })

  it('is a no-op when disabled or when the API is missing', () => {
    installVk({ overlaysContent: false })
    applyVkOverlay(false)()
    expect(isVkOverlayActive()).toBe(false)
    Reflect.deleteProperty(navigator, 'virtualKeyboard')
    expect(() => applyVkOverlay(true)()).not.toThrow()
  })
})

describe('readVkRect', () => {
  it('passes every raw coordinate through, including top/bottom', () => {
    installVk({
      overlaysContent: true,
      boundingRect: { x: 0, y: 500.4, width: 390, height: 300.6, top: 500, bottom: 801 },
    })
    expect(readVkRect()).toEqual({ x: 0, y: 500.4, width: 390, height: 300.6, top: 500, bottom: 801 })
  })

  it('reports nulls when there is no rect', () => {
    installVk({})
    expect(readVkRect()).toEqual({ x: null, y: null, width: null, height: null, top: null, bottom: null })
    Reflect.deleteProperty(navigator, 'virtualKeyboard')
    expect(readVkRect().height).toBeNull()
  })
})

describe('UrlbarCalibrator', () => {
  it('derives the URL-bar height from the closed-state innerHeight spread', () => {
    const calibrator = new UrlbarCalibrator()
    expect(calibrator.estimate).toBeNull()
    calibrator.observe(658, false)
    expect(calibrator.estimate).toBe(0)
    calibrator.observe(710, false) // toolbar collapsed
    calibrator.observe(700, false)
    expect(calibrator.estimate).toBe(52)
  })

  it('ignores open-keyboard samples and NaN', () => {
    const calibrator = new UrlbarCalibrator()
    calibrator.observe(658, false)
    calibrator.observe(336, true)
    calibrator.observe(Number.NaN, false)
    expect(calibrator.estimate).toBe(0)
  })

  it('resets', () => {
    const calibrator = new UrlbarCalibrator()
    calibrator.observe(658, false)
    calibrator.reset()
    expect(calibrator.estimate).toBeNull()
  })
})

describe('estimateVkBottom', () => {
  it('derives the keyboard top from screen height', () => {
    expect(estimateVkBottom(300.6, 800, 52)).toBe(447)
  })

  it('needs all three inputs', () => {
    expect(estimateVkBottom(null, 800, 52)).toBeNull()
    expect(estimateVkBottom(300, null, 52)).toBeNull()
    expect(estimateVkBottom(300, 800, null)).toBeNull()
  })
})

describe('createVkGeometrySampler', () => {
  it('records every geometrychange frame with raw values', () => {
    window.localStorage.setItem('tmuxgo-debug-mobile', '1')
    let listener: (() => void) | null = null
    const removed: string[] = []
    installVk({
      overlaysContent: true,
      boundingRect: { x: 0, y: 610, width: 390, height: 180.5, top: 610, bottom: 790.5 },
      addEventListener: (type, cb) => {
        expect(type).toBe('geometrychange')
        listener = cb
      },
      removeEventListener: (type) => removed.push(type),
    })
    const sampler = createVkGeometrySampler()
    expect(listener).not.toBeNull()
    ;(listener as unknown as () => void)()
    const state = (window as typeof window & { __tmuxgoMobileDiagnostics?: { events: Array<Record<string, unknown>> } })
      .__tmuxgoMobileDiagnostics
    expect(state?.events.at(-1)).toMatchObject({
      event: 'viewport-vk-geometry',
      x: 0,
      y: 610,
      width: 390,
      height: 180.5,
      top: 610,
      bottom: 790.5,
      overlaysContent: true,
    })
    sampler.dispose()
    expect(removed).toEqual(['geometrychange'])
  })

  it('is inert when the API is missing', () => {
    Reflect.deleteProperty(navigator, 'virtualKeyboard')
    const sampler = createVkGeometrySampler()
    expect(() => sampler.dispose()).not.toThrow()
  })
})
