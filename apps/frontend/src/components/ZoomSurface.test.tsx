import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZoomSurface } from './ZoomSurface'

function mockViewportSize(w: number, h: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(h)
}

function imageBox() {
  return screen.getByAltText('pic').parentElement as HTMLElement
}

describe('ZoomSurface image mode', () => {
  afterEach(() => vi.restoreAllMocks())

  it('pins the fit box at open so container resizes do not rescale the image', () => {
    mockViewportSize(800, 600)
    const { rerender } = render(
      <ZoomSurface image resetKey="a.png">
        <img alt="pic" />
      </ZoomSurface>,
    )
    const box = imageBox()
    expect(box.style.width).toBe('800px')
    expect(box.style.height).toBe('600px')

    // 分栏拖动=容器变窄：适配盒不重量，显示尺寸保持
    mockViewportSize(400, 600)
    rerender(
      <ZoomSurface image resetKey="a.png">
        <img alt="pic" />
      </ZoomSurface>,
    )
    expect(box.style.width).toBe('800px')

    // 换图才按当前视口重新适配
    rerender(
      <ZoomSurface image resetKey="b.png">
        <img alt="pic" />
      </ZoomSurface>,
    )
    expect(box.style.width).toBe('400px')
  })
})
