import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'g', label: 'Gamma' },
]

function Harness({ initial = 'a', onChange = vi.fn() }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <Select
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
      aria-label="test select"
    />
  )
}

describe('Select', () => {
  it('opens listbox on click and commits selection', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'test select' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeTruthy()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(options[2])
    expect(onChange).toHaveBeenCalledWith('g')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('combobox')).toHaveTextContent('Gamma')
  })
  it('navigates with arrows and commits with Enter', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('g')
  })
  it('wraps navigation and supports Home/End', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' }) // 0 → wrap to last
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('data-active', 'true')
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('data-active', 'true')
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('data-active', 'true')
  })
  it('closes on Escape and returns focus to trigger', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
  it('closes on outside pointerdown', () => {
    render(
      <div>
        <Harness />
        <div data-testid="outside" />
      </div>,
    )
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('type-ahead jumps to matching option', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'g' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('data-active', 'true')
  })
  it('does not open when disabled', () => {
    render(<Select value="a" options={OPTIONS} onChange={vi.fn()} disabled aria-label="disabled select" />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
