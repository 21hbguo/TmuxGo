import { describe, expect, it, vi } from 'vitest'
import { PhysicalWheelClassifier, attachWheelScrollLines } from './editor-wheel-scroll'

const PIXEL = 0
const LINE = 1

const wheel = (dom: HTMLElement, init: WheelEventInit) =>
  dom.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }))

const createTarget = (initial = 0) => {
  const state = { top: initial }
  return {
    state,
    getScrollTop: () => state.top,
    getMaxScrollTop: () => 1000,
    getLineHeight: () => 20,
    setScrollTop: vi.fn(),
  }
}

describe('PhysicalWheelClassifier', () => {
  it('treats line-mode deltas as physical wheel from the first event', () => {
    const classifier = new PhysicalWheelClassifier()
    classifier.accept(0, 3, LINE)
    expect(classifier.isPhysicalMouseWheel()).toBe(true)
  })
  it('treats repeated identical pixel deltas as physical wheel', () => {
    const classifier = new PhysicalWheelClassifier()
    classifier.accept(0, 100, PIXEL)
    expect(classifier.isPhysicalMouseWheel()).toBe(false)
    classifier.accept(0, 100, PIXEL)
    expect(classifier.isPhysicalMouseWheel()).toBe(true)
  })
  it('treats small fractional pixel deltas as touchpad', () => {
    const classifier = new PhysicalWheelClassifier()
    for (const delta of [3.2, 4.1, 2.7, 5.3]) classifier.accept(0, delta, PIXEL)
    expect(classifier.isPhysicalMouseWheel()).toBe(false)
  })
  it('treats dual-axis deltas as touchpad', () => {
    const classifier = new PhysicalWheelClassifier()
    classifier.accept(12, 40, PIXEL)
    classifier.accept(10, 40, PIXEL)
    expect(classifier.isPhysicalMouseWheel()).toBe(false)
  })
})

describe('attachWheelScrollLines', () => {
  it('passes events through when lines is 0', () => {
    const dom = document.createElement('div')
    const target = createTarget()
    attachWheelScrollLines(dom, () => 0, target)
    const event = new WheelEvent('wheel', { deltaY: 100, deltaMode: PIXEL, bubbles: true, cancelable: true })
    dom.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(target.setScrollTop).not.toHaveBeenCalled()
  })
  it('scrolls exactly N lines per wheel notch (line mode)', () => {
    const dom = document.createElement('div')
    const target = createTarget(500)
    attachWheelScrollLines(dom, () => 3, target)
    wheel(dom, { deltaY: 3, deltaMode: LINE })
    expect(target.setScrollTop).toHaveBeenCalledWith(500 + 60)
    wheel(dom, { deltaY: -3, deltaMode: LINE })
    expect(target.setScrollTop).toHaveBeenLastCalledWith(560 - 60)
  })
  it('accumulates from the pending target during smooth scroll animation', () => {
    const dom = document.createElement('div')
    const target = createTarget(0)
    attachWheelScrollLines(dom, () => 3, target)
    wheel(dom, { deltaY: 3, deltaMode: LINE })
    wheel(dom, { deltaY: 3, deltaMode: LINE })
    expect(target.setScrollTop).toHaveBeenNthCalledWith(1, 60)
    // getScrollTop 仍返回 0（动画中间值），第二次须从 pending 目标 60 继续累加
    expect(target.setScrollTop).toHaveBeenNthCalledWith(2, 120)
  })
  it('clamps to scroll bounds', () => {
    const dom = document.createElement('div')
    const target = createTarget(980)
    attachWheelScrollLines(dom, () => 3, target)
    wheel(dom, { deltaY: 3, deltaMode: LINE })
    expect(target.setScrollTop).toHaveBeenLastCalledWith(1000)
    wheel(dom, { deltaY: -3, deltaMode: LINE })
    expect(target.setScrollTop).toHaveBeenLastCalledWith(940)
  })
  it('passes through modified and horizontal-dominant events', () => {
    const dom = document.createElement('div')
    const target = createTarget()
    attachWheelScrollLines(dom, () => 3, target)
    for (const init of [
      { deltaY: 100, deltaMode: PIXEL, ctrlKey: true },
      { deltaY: 100, deltaMode: PIXEL, metaKey: true },
      { deltaY: 100, deltaMode: PIXEL, shiftKey: true },
      { deltaY: 100, deltaMode: PIXEL, altKey: true },
      { deltaX: 120, deltaY: 40, deltaMode: PIXEL },
    ]) {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
      dom.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(target.setScrollTop).not.toHaveBeenCalled()
  })
  it('leaves touchpad-style deltas to native handling', () => {
    const dom = document.createElement('div')
    const target = createTarget()
    attachWheelScrollLines(dom, () => 3, target)
    for (const deltaY of [3.2, 4.1, 2.7]) wheel(dom, { deltaY, deltaMode: PIXEL })
    expect(target.setScrollTop).not.toHaveBeenCalled()
  })
  it('stops handling after dispose', () => {
    const dom = document.createElement('div')
    const target = createTarget()
    const dispose = attachWheelScrollLines(dom, () => 3, target)
    dispose()
    wheel(dom, { deltaY: 3, deltaMode: LINE })
    expect(target.setScrollTop).not.toHaveBeenCalled()
  })
})
