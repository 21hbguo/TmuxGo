import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IconTile } from './IconTile'

describe('IconTile', () => {
  it('renders the 24px accent tile and hides it from the a11y tree', () => {
    const { container } = render(
      <IconTile>
        <svg data-testid="glyph" />
      </IconTile>,
    )
    const tile = container.firstElementChild as HTMLElement
    expect(tile.className).toContain('h-6')
    expect(tile.className).toContain('w-6')
    expect(tile.className).toContain('rounded-apple')
    expect(tile.className).toContain('bg-bg-2')
    expect(tile.className).toContain('text-accent')
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.contains(screen.getByTestId('glyph'))).toBe(true)
  })

  it('merges a consumer className without dropping its own layout classes', () => {
    const { container } = render(<IconTile className="ml-1">x</IconTile>)
    const tile = container.firstElementChild as HTMLElement
    expect(tile.className).toContain('ml-1')
    expect(tile.className).toContain('shrink-0')
  })
})
