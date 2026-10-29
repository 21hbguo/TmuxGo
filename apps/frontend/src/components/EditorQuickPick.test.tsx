import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EditorQuickPick } from './EditorQuickPick'
import { I18nProvider } from '@/i18n'

const items = [
  { id: 'a', label: 'Go to Line', detail: 'Ctrl+G' },
  { id: 'b', label: 'Go to Symbol', detail: 'Ctrl+Shift+O' },
  { id: 'c', label: 'Toggle Word Wrap', keywords: ['wrap'] },
]

function renderPick(overrides: Partial<React.ComponentProps<typeof EditorQuickPick>> = {}) {
  const props: React.ComponentProps<typeof EditorQuickPick> = {
    title: 'Go to Symbol',
    placeholder: 'Filter symbols',
    items,
    emptyLabel: 'No matching results',
    hint: '↑↓ · Enter · Esc',
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(
    <I18nProvider>
      <EditorQuickPick {...props} />
    </I18nProvider>,
  )
  return props
}

const type = (value: string) => fireEvent.change(screen.getByTestId('editor-quickpick-input'), { target: { value } })

describe('EditorQuickPick', () => {
  it('focuses the input and lists every item', () => {
    renderPick()
    expect(document.activeElement).toBe(screen.getByTestId('editor-quickpick-input'))
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('filters as the user types', () => {
    renderPick()
    type('symbol')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Go to SymbolCtrl+Shift+O'])
  })

  it('shows the empty label when nothing matches', () => {
    renderPick()
    type('zzz')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('No matching results')).toBeTruthy()
  })

  it('moves with arrows and selects with Enter', () => {
    const props = renderPick()
    const input = screen.getByTestId('editor-quickpick-input')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('editor-quickpick-item-1').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    // 越界回绕到第一项
    expect(screen.getByTestId('editor-quickpick-item-0').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
  })

  it('closes on Escape without selecting', () => {
    const props = renderPick()
    fireEvent.keyDown(screen.getByTestId('editor-quickpick-input'), { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('selects on click', () => {
    const props = renderPick()
    fireEvent.click(screen.getByTestId('editor-quickpick-item-1'))
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })

  it('hands raw text to onSubmitText when the caller wants to parse it', () => {
    const onSubmitText = vi.fn(() => true)
    const onSelect = vi.fn()
    renderPick({ onSubmitText, onSelect, items: [] })
    type('42:7')
    fireEvent.keyDown(screen.getByTestId('editor-quickpick-input'), { key: 'Enter' })
    expect(onSubmitText).toHaveBeenCalledWith('42:7')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('drops stale selection when the filter shrinks the list', () => {
    const props = renderPick()
    const input = screen.getByTestId('editor-quickpick-input')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    type('wrap')
    expect(screen.getByTestId('editor-quickpick-item-0').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
  })
})
