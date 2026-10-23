import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISPLAY_PANES_TIMEOUT_MS, useDisplayPanes } from './useDisplayPanes'
import type { Pane, Window } from '@/types'

const pane = (over: Partial<Pane> & Pick<Pane, 'id'>): Pane =>
  ({
    windowId: 'local:@1',
    index: 0,
    title: '',
    active: false,
    left: 0,
    top: 0,
    size: { cols: 80, rows: 24 },
    ...over,
  }) as Pane

const panes = [
  pane({ id: 'local:%1', index: 0, left: 0, top: 0 }),
  pane({ id: 'local:%2', index: 1, left: 80, top: 0 }),
  pane({ id: 'local:%3', index: 2, left: 0, top: 24 }),
]
const windows = [
  { id: 'local:@1', name: 'dev' },
  { id: 'local:@2', name: 'ops' },
] as Window[]

function setup(over: Partial<Parameters<typeof useDisplayPanes>[0]> = {}) {
  const onPickPane = vi.fn()
  const onPickWindow = vi.fn()
  const view = renderHook(() =>
    useDisplayPanes({ enabled: true, panes, windows, zoomed: false, onPickPane, onPickWindow, ...over }),
  )
  return { ...view, onPickPane, onPickWindow }
}

// 全局监听挂在 window 上，用 dispatchEvent 模拟真实按键（含 capture）
function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

describe('useDisplayPanes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on Alt+p and lists the window panes in tmux numbering', () => {
    const { result } = setup()
    expect(result.current.active).toBe(false)
    press('p', { altKey: true })
    expect(result.current.active).toBe(true)
    expect(result.current.mode).toBe('panes')
    expect(result.current.targets.map((target) => target.number)).toEqual([1, 2, 3])
  })

  it('ignores plain letters so typing in the terminal stays untouched', () => {
    // 分开断言：连着按两个键时后一个会把已开的层关掉，掩盖前半段的误触发
    const plainP = setup()
    press('p')
    expect(plainP.result.current.active).toBe(false)
    const plainG = setup()
    press('g')
    expect(plainG.result.current.active).toBe(false)
    // 带 Ctrl/Meta 的 p 也不算触发（给浏览器/编辑器留着）
    const ctrlP = setup()
    press('p', { ctrlKey: true })
    expect(ctrlP.result.current.active).toBe(false)
  })

  it('does nothing when disabled (mobile)', () => {
    const { result } = setup({ enabled: false })
    press('p', { altKey: true })
    expect(result.current.active).toBe(false)
  })

  it('picks the pane matching the pressed number and closes the layer', () => {
    const { result, onPickPane, onPickWindow } = setup()
    press('p', { altKey: true })
    const event = new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(onPickPane).toHaveBeenCalledWith('local:%2')
    expect(onPickWindow).not.toHaveBeenCalled()
    // 数字键必须被吞掉，否则会漏进终端
    expect(event.defaultPrevented).toBe(true)
    expect(result.current.active).toBe(false)
  })

  it('cancels on Escape and on any unrelated key', () => {
    const first = setup()
    press('p', { altKey: true })
    press('Escape')
    expect(first.result.current.active).toBe(false)
    expect(first.onPickPane).not.toHaveBeenCalled()

    const second = setup()
    press('p', { altKey: true })
    press('x')
    expect(second.result.current.active).toBe(false)
    expect(second.onPickPane).not.toHaveBeenCalled()
  })

  it('cancels on pointerdown outside the keyboard flow', () => {
    const { result, onPickPane } = setup()
    press('p', { altKey: true })
    act(() => {
      window.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(result.current.active).toBe(false)
    expect(onPickPane).not.toHaveBeenCalled()
  })

  it('auto-closes after the flash window', () => {
    const { result } = setup()
    press('p', { altKey: true })
    act(() => {
      vi.advanceTimersByTime(DISPLAY_PANES_TIMEOUT_MS - 100)
    })
    expect(result.current.active).toBe(true)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.active).toBe(false)
  })

  it('toggles closed when Alt+p is pressed again', () => {
    const { result } = setup()
    press('p', { altKey: true })
    press('p', { altKey: true })
    expect(result.current.active).toBe(false)
  })

  it('degrades to window numbering when zoomed (only one pane is visible)', () => {
    const { result, onPickWindow, onPickPane } = setup({ zoomed: true })
    press('p', { altKey: true })
    expect(result.current.mode).toBe('windows')
    expect(result.current.targets.map((target) => target.label)).toEqual(['dev', 'ops'])
    press('2')
    expect(onPickWindow).toHaveBeenCalledWith('local:@2')
    expect(onPickPane).not.toHaveBeenCalled()
  })

  it('stays closed when there is nowhere to jump', () => {
    const single = setup({ panes: [pane({ id: 'local:%1' })], windows: [windows[0]!] })
    press('p', { altKey: true })
    expect(single.result.current.active).toBe(false)
  })
})
