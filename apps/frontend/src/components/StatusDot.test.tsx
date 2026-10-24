import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusDot } from './StatusDot'

describe('StatusDot', () => {
  it('defaults to a 6px muted dot hidden from the a11y tree', () => {
    const { container } = render(<StatusDot />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.className).toContain('h-1.5')
    expect(dot.className).toContain('w-1.5')
    expect(dot.className).toContain('bg-text-3')
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })

  it('maps every semantic tone onto its token color', () => {
    const cases: Array<[Parameters<typeof StatusDot>[0]['tone'], string]> = [
      ['accent', 'bg-accent'],
      ['success', 'bg-accent-2'],
      ['warning', 'bg-warn'],
      ['danger', 'bg-danger'],
      ['muted', 'bg-text-3'],
    ]
    for (const [tone, expected] of cases) {
      const { container, unmount } = render(<StatusDot tone={tone} />)
      expect((container.firstElementChild as HTMLElement).className).toContain(expected)
      unmount()
    }
  })

  it('supports the md size and pulse for in-progress states', () => {
    const { container } = render(<StatusDot tone="accent" size="md" pulse />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.className).toContain('h-2')
    expect(dot.className).toContain('w-2')
    expect(dot.className).toContain('animate-pulse')
  })

  it('exposes a label as a readable status role', () => {
    render(<StatusDot tone="warning" label="Attaching" />)
    const dot = screen.getByRole('status', { name: 'Attaching' })
    expect(dot.getAttribute('aria-hidden')).toBeNull()
  })
})
