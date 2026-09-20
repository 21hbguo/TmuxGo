import { beforeEach, describe, expect, it } from 'vitest'
import { createTerminalResizeMask } from './terminal-resize-mask'

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect

const stubRect = (el: HTMLElement, r: DOMRect) => {
  el.getBoundingClientRect = () => r
}

const stubClientSize = (el: HTMLElement, w: number, h: number) => {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true })
}

const makeScreen = () => {
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  const rows = document.createElement('div')
  rows.className = 'xterm-rows'
  rows.textContent = 'content'
  screen.appendChild(rows)
  return screen
}

describe('terminal-resize-mask snapshot geometry', () => {
  let maskEl: HTMLElement
  let screen: HTMLElement
  let terminal: any
  beforeEach(() => {
    document.body.innerHTML = ''
    maskEl = document.createElement('div')
    maskEl.style.display = 'none'
    document.body.appendChild(maskEl)
    screen = makeScreen()
    terminal = { element: document.createElement('div') }
    terminal.element.appendChild(screen)
    document.body.appendChild(terminal.element)
  })

  it('pins the clone to the real screen top when the screen does not fill the mask bottom', () => {
    // shared/非独占：screen 按行高收缩，底边不到 mask 底——克隆不得底部锚定下移
    stubRect(maskEl, rect(100, 40, 800, 600))
    stubRect(screen, rect(108, 48, 784, 520)) // 底边距 mask 底 80px
    stubClientSize(maskEl, 800, 600)
    const mask = createTerminalResizeMask({ mask: maskEl, getTerminal: () => terminal })
    mask.show()
    const clone = maskEl.firstElementChild as HTMLElement
    expect(clone).toBeTruthy()
    expect(clone.style.top).toBe('8px') // screen.top-mask.top=48-40，非 maskH-screenH=80
    expect(clone.style.left).toBe('8px')
    expect(clone.style.width).toBe('784px')
    expect(clone.style.height).toBe('520px')
    mask.dispose()
  })

  it('bottom-anchors by shifting up only the overflow when the screen outgrows the mask', () => {
    // 容器已变矮、screen 还没跟上（底边溢出 40px）：上移溢出量保住 prompt 行
    stubRect(maskEl, rect(100, 40, 800, 560))
    stubRect(screen, rect(108, 40, 784, 600))
    stubClientSize(maskEl, 800, 560)
    const mask = createTerminalResizeMask({ mask: maskEl, getTerminal: () => terminal })
    mask.show()
    const clone = maskEl.firstElementChild as HTMLElement
    expect(clone.style.top).toBe('-40px') // topOffset=0，上移溢出 40
    mask.dispose()
  })

  it('recaptures when the mask geometry changed while still displayed', () => {
    stubRect(maskEl, rect(100, 40, 800, 600))
    stubRect(screen, rect(108, 48, 784, 560))
    stubClientSize(maskEl, 800, 600)
    const mask = createTerminalResizeMask({ mask: maskEl, getTerminal: () => terminal })
    mask.show()
    const first = maskEl.firstElementChild as HTMLElement
    // 容器继续变化、mask 仍显示：再次 show 必须重截，克隆贴新几何
    stubRect(maskEl, rect(100, 40, 720, 560))
    stubClientSize(maskEl, 720, 560)
    stubRect(screen, rect(108, 48, 704, 520))
    mask.show()
    const second = maskEl.firstElementChild as HTMLElement
    expect(second).not.toBe(first)
    expect(second.style.width).toBe('704px')
    expect(second.style.top).toBe('8px')
    mask.dispose()
  })

  it('does not recapture when geometry is unchanged while displayed', () => {
    stubRect(maskEl, rect(100, 40, 800, 600))
    stubRect(screen, rect(108, 48, 784, 560))
    stubClientSize(maskEl, 800, 600)
    const mask = createTerminalResizeMask({ mask: maskEl, getTerminal: () => terminal })
    mask.show()
    const first = maskEl.firstElementChild as HTMLElement
    mask.show() // 同几何：generation 递增但不重截
    expect(maskEl.firstElementChild).toBe(first)
    mask.dispose()
  })

  it('strips screen transform from the clone (rect already bakes in the offset)', () => {
    screen.style.transform = 'translateY(-120px)'
    stubRect(maskEl, rect(100, 40, 800, 480))
    stubRect(screen, rect(108, -80, 784, 600)) // rect 已含 translateY
    stubClientSize(maskEl, 800, 480)
    const mask = createTerminalResizeMask({ mask: maskEl, getTerminal: () => terminal })
    mask.show()
    const clone = maskEl.firstElementChild as HTMLElement
    expect(clone.style.transform).toBe('')
    // topOffset=-80-40=-120；screen.bottom=-80+600=520=mask.bottom 无溢出 → 贴 -120
    expect(clone.style.top).toBe('-120px')
    mask.dispose()
  })
})
