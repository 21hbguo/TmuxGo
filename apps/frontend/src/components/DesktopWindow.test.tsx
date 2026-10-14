import { fireEvent, render } from '@testing-library/react'
import React from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DesktopWindow } from './DesktopWindow'

// jsdom 未实现 pointer capture API，补 no-op 桩
beforeAll(() => {
  const proto = Element.prototype as any
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
})

function renderWindow(windowed = true, onTitlebarDoubleClick?: () => void) {
  return render(
    <DesktopWindow windowed={windowed} onTitlebarDoubleClick={onTitlebarDoubleClick}>
      <header data-desktop-titlebar>
        <span>title</span>
        <button type="button">action</button>
      </header>
    </DesktopWindow>,
  )
}

// windowed 态双击 = 两次标题栏 tap(pointerdown 于标题栏空白区、pointerup 于容器)
function tapTitlebar(win: HTMLElement, el: HTMLElement, x = 100, y = 10) {
  fireEvent.pointerDown(el, { button: 0, clientX: x, clientY: y, pointerId: 1 })
  fireEvent.pointerUp(win, { clientX: x, clientY: y, pointerId: 1 })
}

describe('DesktopWindow', () => {
  it('maximizes and restores on titlebar double-tap', () => {
    const { container } = renderWindow()
    const win = container.firstChild as HTMLElement
    const titlebar = win.querySelector('[data-desktop-titlebar]') as HTMLElement
    expect(win.style.width).not.toBe('')
    tapTitlebar(win, titlebar)
    tapTitlebar(win, titlebar)
    expect(win.className).toContain('inset-0')
    expect(win.style.width).toBe('')
    tapTitlebar(win, titlebar)
    tapTitlebar(win, titlebar)
    expect(win.className).not.toContain('inset-0')
    expect(win.style.width).not.toBe('')
  })

  it('ignores taps on interactive elements inside the titlebar', () => {
    const { container } = renderWindow()
    const win = container.firstChild as HTMLElement
    const button = win.querySelector('button') as HTMLElement
    tapTitlebar(win, button)
    tapTitlebar(win, button)
    expect(win.className).not.toContain('inset-0')
    expect(win.style.width).not.toBe('')
  })

  it('does not treat two slow taps as a double-tap', () => {
    const nowSpy = vi.spyOn(performance, 'now')
    const { container } = renderWindow()
    const win = container.firstChild as HTMLElement
    const titlebar = win.querySelector('[data-desktop-titlebar]') as HTMLElement
    nowSpy.mockReturnValue(1000)
    tapTitlebar(win, titlebar)
    nowSpy.mockReturnValue(1600)
    tapTitlebar(win, titlebar)
    expect(win.className).not.toContain('inset-0')
    nowSpy.mockReturnValue(1650)
    tapTitlebar(win, titlebar)
    expect(win.className).toContain('inset-0')
    nowSpy.mockRestore()
  })

  it('hides resize zones and ignores move drags while maximized', () => {
    const { container } = renderWindow()
    const win = container.firstChild as HTMLElement
    const titlebar = win.querySelector('[data-desktop-titlebar]') as HTMLElement
    const widthBefore = win.style.width
    const leftBefore = win.style.left
    tapTitlebar(win, titlebar)
    tapTitlebar(win, titlebar)
    expect(win.querySelector('[data-desktop-resize]')).toBeNull()
    fireEvent.pointerDown(titlebar, { button: 0, clientX: 100, clientY: 10 })
    fireEvent.pointerMove(win, { clientX: 300, clientY: 60 })
    fireEvent.pointerUp(win, { clientX: 300, clientY: 60 })
    tapTitlebar(win, titlebar)
    tapTitlebar(win, titlebar)
    expect(win.style.width).toBe(widthBefore)
    expect(win.style.left).toBe(leftBefore)
  })

  it('delegates titlebar double-click to the outer view switch when not windowed', () => {
    const onTitlebarDoubleClick = vi.fn()
    const { container } = renderWindow(false, onTitlebarDoubleClick)
    const win = container.firstChild as HTMLElement
    fireEvent.doubleClick(win.querySelector('[data-desktop-titlebar]') as HTMLElement)
    expect(onTitlebarDoubleClick).toHaveBeenCalledTimes(1)
    expect(win.className).toContain('h-full')
    fireEvent.doubleClick(win.querySelector('button') as HTMLElement)
    expect(onTitlebarDoubleClick).toHaveBeenCalledTimes(1)
  })
})
