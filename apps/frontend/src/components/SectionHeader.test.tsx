import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SectionHeader } from './SectionHeader'

describe('SectionHeader', () => {
  it('renders title and trailing count', () => {
    const { container } = render(<SectionHeader title="devbox" count={4} />)
    const header = container.firstElementChild as HTMLElement
    expect(header.className).toContain('border-b')
    expect(screen.getByText('devbox').className).toContain('text-caption')
    const count = screen.getByText('4')
    expect(count.className).toContain('ml-auto')
    expect(count.className).toContain('tabular-nums')
  })

  it('renders a leading slot and no count when omitted', () => {
    const { container } = render(<SectionHeader title="local" leading={<span data-testid="dot" />} />)
    expect(screen.getByTestId('dot')).toBeTruthy()
    expect(container.querySelector('.ml-auto')).toBeNull()
  })

  it('keeps sticky pinning a consumer concern via className', () => {
    const { container } = render(<SectionHeader title="group" className="sticky top-0 bg-bg-0/95" />)
    expect((container.firstElementChild as HTMLElement).className).toContain('sticky')
  })
})
