import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FilterToggle } from './FilterToggle'

describe('FilterToggle', () => {
  it('derives aria-pressed from pressed and applies the accent modifier by default', () => {
    render(<FilterToggle pressed>Only task</FilterToggle>)
    const toggle = screen.getByRole('button', { name: 'Only task' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.className).toContain('tmuxgo-filter-toggle')
    expect(toggle.className).toContain('tmuxgo-filter-toggle--accent')
    expect(toggle.className).toContain('h-7')
  })

  it('starts neutral when pressed is false and keeps danger tone when pressed', () => {
    const { rerender } = render(
      <FilterToggle pressed={false} tone="danger">
        Only attention
      </FilterToggle>,
    )
    const toggle = screen.getByRole('button', { name: 'Only attention' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.className).toContain('tmuxgo-filter-toggle--danger')
    rerender(
      <FilterToggle pressed tone="danger">
        Only attention
      </FilterToggle>,
    )
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('forwards clicks and native button props', () => {
    const onClick = vi.fn()
    render(
      <FilterToggle pressed={false} disabled={false} title="tip" onClick={onClick}>
        Has task
      </FilterToggle>,
    )
    const toggle = screen.getByRole('button', { name: 'Has task' })
    expect(toggle.getAttribute('title')).toBe('tip')
    fireEvent.click(toggle)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('blocks clicks when disabled', () => {
    const onClick = vi.fn()
    render(
      <FilterToggle pressed disabled onClick={onClick}>
        Busy
      </FilterToggle>,
    )
    const toggle = screen.getByRole('button', { name: 'Busy' }) as HTMLButtonElement
    fireEvent.click(toggle)
    expect(toggle.disabled).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
  })
})
