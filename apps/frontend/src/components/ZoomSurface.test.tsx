import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZoomSurface } from './ZoomSurface'

function mockViewportSize(w: number, h: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(h)
}

function imageBox() {
  return screen.getByAltText('pic').parentElement as HTMLElement
}

// jsdom 无 ResizeObserver：手工 stub，保存回调后用 act 模拟视口尺寸变化
function stubResizeObserver() {
  let cb: ResizeObserverCallback | null = null
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        cb = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  return {
    notify() {
      const callback = cb
      act(() => callback?.([], {} as ResizeObserver))
    },
  }
}

describe('ZoomSurface image mode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('pins the fit box at open so container growth does not rescale the image', () => {
    const ro = stubResizeObserver()
    mockViewportSize(800, 600)
    const { rerender } = render(
      <ZoomSurface image resetKey="a.png">
        <img alt="pic" />
      </ZoomSurface>,
    )
    const box = imageBox()
    ro.notify()
    expect(box.style.width).toBe('800px')
    expect(box.style.height).toBe('600px')

    // 分栏拖动=容器变宽：适配盒不重量，显示尺寸保持（缩放率与所见尺寸一致）
    mockViewportSize(1200, 900)
    ro.notify()
    expect(box.style.width).toBe('800px')

    // 换图才按当前视口重新适配
    rerender(
      <ZoomSurface image resetKey="b.png">
        <img alt="pic" />
      </ZoomSurface>,
    )
    expect(box.style.width).toBe('1200px')
  })

  it('clamps the pinned fit box to a shrinking viewport so the image is never cropped', () => {
    const ro = stubResizeObserver()
    mockViewportSize(800, 600)
    render(
      <ZoomSurface image resetKey="a.png">
        <img alt="pic" />
      </ZoomSurface>,
    )
    const box = imageBox()
    ro.notify()

    // 容器收窄：适配盒跟随视口重适配，否则居中旧盒 + overflow-hidden 会裁掉图
    mockViewportSize(400, 300)
    ro.notify()
    expect(box.style.width).toBe('400px')
    expect(box.style.height).toBe('300px')

    // 再放大回到钉死上限为止
    mockViewportSize(1200, 900)
    ro.notify()
    expect(box.style.width).toBe('800px')
  })
})
