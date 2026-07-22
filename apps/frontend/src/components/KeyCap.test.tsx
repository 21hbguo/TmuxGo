import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { vi } from 'vitest'
import { KeyCap } from './KeyCap'

describe('KeyCap', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

  it('renders base class with default tone', () => {
    render(<KeyCap>Esc</KeyCap>)
    const btn = screen.getByRole('button', { name: 'Esc' })
    expect(btn.className).toContain('tmuxgo-keycap')
    expect(btn.className).not.toContain('tmuxgo-keycap--accent')
    expect(btn.className).not.toContain('tmuxgo-keycap--dock')
  })

  it('applies variant + tone + size classes', () => {
    render(<KeyCap variant="dock" tone="accent" size="freq">↵ Enter</KeyCap>)
    const btn = screen.getByRole('button', { name: '↵ Enter' })
    expect(btn.className).toContain('tmuxgo-keycap--dock')
    expect(btn.className).toContain('tmuxgo-keycap--accent')
    expect(btn.className).toContain('tmuxgo-keycap--freq')
  })

  it('calls onPress on click and prevents focus', () => {
    const onPress = vi.fn()
    render(<KeyCap onPress={onPress}>Tab</KeyCap>)
    const btn = screen.getByRole('button', { name: 'Tab' })
    fireEvent.click(btn)
    expect(onPress).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(btn, { pointerId: 1, pointerType: 'mouse' })
    fireEvent.pointerUp(btn, { pointerId: 1, pointerType: 'mouse' })
    // focus should be prevented
    expect(document.activeElement).not.toBe(btn)
  })

  it('skips onPress when disabled', () => {
    const onPress = vi.fn()
    render(<KeyCap onPress={onPress} disabled>X</KeyCap>)
    fireEvent.click(screen.getByRole('button', { name: 'X' }))
    expect(onPress).not.toHaveBeenCalled()
  })

  it('fires repeat on hold with delay then interval', () => {
    const onPress = vi.fn()
    render(<KeyCap onPress={onPress} repeat repeatDelay={420} repeatInterval={54}>↑</KeyCap>)
    const btn = screen.getByRole('button', { name: '↑' })
    fireEvent.pointerDown(btn, { pointerId: 1, pointerType: 'mouse' })
    expect(onPress).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(420) })
    expect(onPress).toHaveBeenCalledTimes(2)
    act(() => { vi.advanceTimersByTime(54) })
    expect(onPress).toHaveBeenCalledTimes(3)
    fireEvent.pointerUp(btn, { pointerId: 1, pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(200) })
    expect(onPress).toHaveBeenCalledTimes(3)
  })

  it('gesture mode: forwards pointer events to consumer', () => {
    const onPointerDown = vi.fn()
    const onPointerUp = vi.fn()
    render(<KeyCap onPointerDown={onPointerDown} onPointerUp={onPointerUp}>Y</KeyCap>)
    const btn = screen.getByRole('button', { name: 'Y' })
    fireEvent.pointerDown(btn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(btn, { pointerId: 1, pointerType: 'touch' })
    expect(onPointerDown).toHaveBeenCalledTimes(1)
    expect(onPointerUp).toHaveBeenCalledTimes(1)
  })

  it('passes extra props to underlying button', () => {
    render(<KeyCap tabIndex={-1} aria-label="close" title="X">X</KeyCap>)
    const btn = screen.getByRole('button', { name: 'close' })
    expect(btn.getAttribute('tabindex')).toBe('-1')
    expect(btn.getAttribute('title')).toBe('X')
  })
})
