import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EditorContextMenu, type EditorMenuAction } from './EditorContextMenu'

function renderMenu(overrides: Partial<React.ComponentProps<typeof EditorContextMenu>> = {}) {
  const actions: EditorMenuAction[] = [
    { id: 'close', label: 'Close', onSelect: vi.fn() },
    { id: 'close-others', label: 'Close Others', shortcut: 'Ctrl+K O', onSelect: vi.fn() },
    { id: 'split', label: 'Split Right', separatorBefore: true, onSelect: vi.fn() },
    { id: 'disabled', label: 'Disabled', disabled: true, onSelect: vi.fn() },
  ]
  const props: React.ComponentProps<typeof EditorContextMenu> = { x: 40, y: 60, actions, onClose: vi.fn(), ...overrides }
  render(<EditorContextMenu {...props} />)
  return { actions, props }
}

describe('EditorContextMenu', () => {
  it('renders items with shortcuts and separators', () => {
    renderMenu()
    const menu = screen.getByTestId('editor-context-menu')
    expect(menu.textContent).toContain('Close Others')
    expect(menu.textContent).toContain('Ctrl+K O')
    expect(menu.querySelectorAll('.h-px')).toHaveLength(1)
  })

  it('runs the action and closes', () => {
    const { actions, props } = renderMenu()
    fireEvent.click(screen.getByText('Close Others'))
    expect(props.onClose).toHaveBeenCalled()
    expect(actions[1].onSelect).toHaveBeenCalled()
  })

  it('ignores disabled items', () => {
    const { actions, props } = renderMenu()
    fireEvent.click(screen.getByText('Disabled'))
    expect(props.onClose).not.toHaveBeenCalled()
    expect(actions[3].onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { props } = renderMenu()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('closes on outside pointer down but not inside', () => {
    const { props } = renderMenu()
    fireEvent.pointerDown(screen.getByTestId('editor-context-menu'))
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('opens upward when asked and stays inside the viewport', () => {
    renderMenu({ openUp: true, x: 10_000, y: 10_000 })
    const menu = screen.getByTestId('editor-context-menu')
    const left = Number.parseFloat(menu.style.left)
    const top = Number.parseFloat(menu.style.top)
    expect(left).toBeLessThan(window.innerWidth)
    expect(top).toBeGreaterThanOrEqual(8)
    expect(top).toBeLessThan(10_000)
  })
})
