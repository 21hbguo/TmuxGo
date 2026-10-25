import { afterEach, describe, expect, it } from 'vitest'
import { hasViewportOcclusion, readViewportOcclusion, writeViewportOcclusion } from './viewportOcclusion'

const ATTR = 'data-viewport-occlusion'

describe('viewportOcclusion', () => {
  afterEach(() => {
    document.body.removeAttribute(ATTR)
    document.body.className = ''
  })

  it('round-trips the model-mode occlusion height on the body attribute', () => {
    writeViewportOcclusion(322)
    expect(document.body.getAttribute(ATTR)).toBe('322')
    expect(readViewportOcclusion()).toBe(322)
    expect(hasViewportOcclusion()).toBe(true)
  })

  it('rounds fractional heights instead of writing a float', () => {
    writeViewportOcclusion(321.6)
    expect(document.body.getAttribute(ATTR)).toBe('322')
  })

  it('removes the attribute when the occlusion is gone, so stale causes cannot persist', () => {
    writeViewportOcclusion(322)
    writeViewportOcclusion(0)
    expect(document.body.hasAttribute(ATTR)).toBe(false)
    expect(readViewportOcclusion()).toBe(0)
  })

  it('treats null and non-finite values as no occlusion', () => {
    writeViewportOcclusion(200)
    writeViewportOcclusion(null)
    expect(document.body.hasAttribute(ATTR)).toBe(false)
    writeViewportOcclusion(Number.NaN)
    expect(document.body.hasAttribute(ATTR)).toBe(false)
    writeViewportOcclusion(-40)
    expect(document.body.hasAttribute(ATTR)).toBe(false)
  })

  it('falls back to the legacy body class when the attribute is absent', () => {
    expect(readViewportOcclusion()).toBe(0)
    expect(hasViewportOcclusion()).toBe(false)
    document.body.classList.add('keyboard-open')
    expect(hasViewportOcclusion()).toBe(true)
  })

  it('keeps the class fallback working even when model mode wrote zero', () => {
    // model 模式判定为无遮挡、但 legacy 机器已经把 class 打上：保守方向是仍按
    // 遮挡处理（多裁一次无害，误 refit 会改远端窗口）
    writeViewportOcclusion(0)
    document.body.classList.add('keyboard-open')
    expect(hasViewportOcclusion()).toBe(true)
  })

  it('ignores a corrupted attribute value rather than trusting NaN', () => {
    document.body.setAttribute(ATTR, 'oops')
    expect(readViewportOcclusion()).toBe(0)
    document.body.setAttribute(ATTR, '-9')
    expect(readViewportOcclusion()).toBe(0)
  })
})
