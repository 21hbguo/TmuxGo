import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the title only, with the shared empty-state layout', () => {
    const { container } = render(<EmptyState title="No matches" />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('tmuxgo-empty-state')
    expect(screen.getByText('No matches').className).toContain('text-text-2')
    expect(root.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('renders icon, description and action', () => {
    const onRetry = vi.fn()
    const { container } = render(
      <EmptyState
        title="Nothing here"
        description="Agents are not installed yet"
        icon={<span data-testid="glyph" />}
        action={
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        }
      />,
    )
    expect(screen.getByTestId('glyph')).toBeTruthy()
    expect(screen.getByText('Agents are not installed yet').className).toContain('text-caption')
    expect((container.firstElementChild as HTMLElement).querySelector('[aria-hidden="true"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('lets preview areas center themselves through className', () => {
    const { container } = render(<EmptyState title="No preview" className="flex-1 justify-center" />)
    expect((container.firstElementChild as HTMLElement).className).toContain('flex-1')
  })
})
