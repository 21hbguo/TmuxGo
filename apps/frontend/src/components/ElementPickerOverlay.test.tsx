import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElementPickerOverlay } from './ElementPickerOverlay'
import { useElementPickerStore } from '@/stores/useElementPickerStore'

// 高亮节流走 rAF——测试里同步执行，省掉计时器依赖
function syncRaf() {
  return vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0)
    return 0
  })
}

describe('ElementPickerOverlay', () => {
  beforeEach(() => {
    useElementPickerStore.setState({ active: false, selected: null })
    syncRaf()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    act(() => useElementPickerStore.getState().stop())
  })

  it('renders nothing while inactive', () => {
    render(<ElementPickerOverlay />)
    expect(document.body.querySelector('[data-element-picker-ui]')).toBeNull()
  })

  it('highlights hovered element and selects on click', () => {
    render(
      <div>
        <button id="pick-me">x</button>
        <ElementPickerOverlay />
      </div>,
    )
    act(() => useElementPickerStore.getState().start())
    const button = screen.getByRole('button', { name: 'x' })
    fireEvent.mouseMove(button)
    expect(document.body.textContent).toContain('button#pick-me')
    fireEvent.click(button)
    const selected = useElementPickerStore.getState().selected
    expect(selected?.selector).toBe('#pick-me')
    // 点击后弹出信息面板
    expect(document.body.querySelector('[data-element-picker-ui]')).not.toBeNull()
  })

  it('swallows clicks on the page instead of triggering them', () => {
    const onClick = vi.fn()
    render(
      <div>
        <button onClick={onClick}>x</button>
        <ElementPickerOverlay />
      </div>,
    )
    act(() => useElementPickerStore.getState().start())
    fireEvent.click(screen.getByRole('button', { name: 'x' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('exits on Escape', () => {
    render(<ElementPickerOverlay />)
    act(() => useElementPickerStore.getState().start())
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(useElementPickerStore.getState().active).toBe(false)
    expect(document.body.querySelector('[data-element-picker-ui]')).toBeNull()
  })

  it('does not intercept clicks inside the picker panel', () => {
    render(
      <div>
        <button id="a">x</button>
        <ElementPickerOverlay />
      </div>,
    )
    act(() => useElementPickerStore.getState().start())
    fireEvent.click(screen.getByRole('button', { name: 'x' }))
    expect(useElementPickerStore.getState().selected?.selector).toBe('#a')
    // 面板关闭按钮正常工作（点击不被拾取器拦截），清空选中但保持选择模式
    fireEvent.click(screen.getByLabelText('common.close'))
    expect(useElementPickerStore.getState().selected).toBeNull()
    expect(useElementPickerStore.getState().active).toBe(true)
  })
})
