import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ListRow } from './ListRow'

describe('ListRow', () => {
  it('renders a compact row with the shared transition class and subtle divider', () => {
    const { container } = render(<ListRow>session-a</ListRow>)
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain('tmuxgo-list-row')
    expect(row.className).toContain('py-1.5')
    expect(row.className).toContain('border-[var(--line-subtle)]')
    expect(screen.getByText('session-a')).toBeTruthy()
  })

  it('passes native div attributes and merges consumer state classes', () => {
    const onClick = vi.fn()
    const { container } = render(
      <ListRow className="tmuxgo-list-row--hover tmuxgo-list-row--active" onClick={onClick} data-row="a">
        row
      </ListRow>,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain('tmuxgo-list-row--hover')
    expect(row.className).toContain('tmuxgo-list-row--active')
    expect(row.getAttribute('data-row')).toBe('a')
    fireEvent.click(row)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('keeps its children structure untouched', () => {
    const { container } = render(
      <ListRow>
        <button type="button">open</button>
        <span>tail</span>
      </ListRow>,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.children).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'open' })).toBeTruthy()
  })
})
