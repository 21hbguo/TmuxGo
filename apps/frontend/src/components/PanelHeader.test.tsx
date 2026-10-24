import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PanelHeader } from './PanelHeader'

describe('PanelHeader', () => {
  it('renders the icon tile, title and subtitle in the h-11 bar', () => {
    const { container } = render(<PanelHeader icon={<span data-testid="glyph" />} title="Fleet" subtitle="12 agents" />)
    const header = container.querySelector('header') as HTMLElement
    expect(header.className).toContain('h-11')
    expect(header.className).toContain('px-3')
    expect(header.className).toContain('border-b')
    expect(screen.getByTestId('glyph')).toBeTruthy()
    expect(screen.getByText('Fleet').className).toContain('text-xs')
    expect(screen.getByText('12 agents').className).toContain('text-caption')
  })

  it('renders actions and fires onClose from the labelled close button', () => {
    const onClose = vi.fn()
    render(
      <PanelHeader
        title="Inbox"
        actions={<button type="button">refresh</button>}
        onClose={onClose}
        closeLabel="Close"
      />,
    )
    expect(screen.getByRole('button', { name: 'refresh' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('omits icon, subtitle and close button when not requested', () => {
    const { container } = render(<PanelHeader title="Ssh" />)
    const header = container.querySelector('header') as HTMLElement
    expect(screen.queryByRole('button')).toBeNull()
    expect(header.querySelector('.rounded-apple')).toBeNull()
    expect(header.querySelector('.text-caption')).toBeNull()
  })

  it('lets the consumer override the height via className', () => {
    const { container } = render(<PanelHeader title="Inbox" className="h-10" />)
    expect((container.querySelector('header') as HTMLElement).className).toContain('h-10')
  })
})
