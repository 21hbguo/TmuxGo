import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentStatusBadge } from './AgentStatusBadge'

// 只测原语接线（tone 映射 + 圆点/计数），i18n 走最小桩
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key.replace('agent.status.', '') }),
}))

describe('AgentStatusBadge', () => {
  it('maps statuses onto the shared surface tones', () => {
    const { container, rerender } = render(<AgentStatusBadge status="blocked" />)
    let badge = container.firstElementChild as HTMLElement
    expect(badge.className).toContain('border-danger/35')
    expect(badge.className).toContain('text-danger')
    rerender(<AgentStatusBadge status="done" />)
    badge = container.firstElementChild as HTMLElement
    expect(badge.className).toContain('text-accent-2')
    rerender(<AgentStatusBadge status="idle" />)
    badge = container.firstElementChild as HTMLElement
    expect(badge.className).toContain('text-text-3')
  })

  it('pulses the dot only for working and hides the count when compact', () => {
    const { container, rerender } = render(<AgentStatusBadge status="working" />)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
    rerender(<AgentStatusBadge summary={{ idle: 0, working: 3, blocked: 0, done: 0, unknown: 0, total: 3 }} compact />)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
    expect((container.firstElementChild as HTMLElement).className).toContain('justify-center')
    expect(screen.queryByText('3')).toBeNull()
  })

  it('renders one clickable pill per visible status in summary mode', () => {
    const onStatusClick = vi.fn()
    render(
      <AgentStatusBadge
        summary={{ idle: 1, working: 0, blocked: 2, done: 0, unknown: 0, total: 3 }}
        onStatusClick={onStatusClick}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'blocked' }))
    expect(onStatusClick).toHaveBeenCalledWith('blocked')
    expect(screen.getByRole('button', { name: 'idle' })).toBeTruthy()
  })
})
