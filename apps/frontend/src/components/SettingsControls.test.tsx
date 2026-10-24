import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingRow, SettingsSwitch } from './SettingsControls'

describe('SettingsSwitch', () => {
  it('exposes the toggle state through aria-pressed and a readable label', () => {
    render(<SettingsSwitch checked onChange={vi.fn()} label="Auto reconnect" />)
    const toggle = screen.getByRole('button', { name: 'Auto reconnect' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.className).toContain('tmuxgo-focus-ring')
    expect(toggle.className).toContain('bg-accent')
  })

  it('flips the visually hidden knob with a transform class instead of position offsets', () => {
    const { container, rerender } = render(<SettingsSwitch checked onChange={vi.fn()} label="Cursor blink" />)
    let knob = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(knob.className).toContain('translate-x-4')
    expect(knob.className).toContain('transition-transform')
    expect(knob.className).not.toContain('transition-all')
    rerender(<SettingsSwitch checked={false} onChange={vi.fn()} label="Cursor blink" />)
    knob = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(knob.className).toContain('translate-x-0')
    expect(container.firstElementChild?.className).toContain('bg-bg-2')
  })

  it('reports the next value and blocks interaction when disabled', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SettingsSwitch checked={false} onChange={onChange} label="Show status bar" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show status bar' }))
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<SettingsSwitch checked disabled onChange={onChange} label="Show status bar" />)
    const toggle = screen.getByRole('button', { name: 'Show status bar' }) as HTMLButtonElement
    fireEvent.click(toggle)
    expect(toggle.disabled).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('SettingRow', () => {
  it('renders label, description and a tabular value', () => {
    render(<SettingRow label="Reconnect interval" description="Retry delay" value="3s" />)
    expect(screen.getByText('Reconnect interval').className).toContain('text-text-2')
    expect(screen.getByText('Retry delay').className).toContain('text-caption')
    const value = screen.getByText('3s')
    expect(value.className).toContain('text-text-1')
    expect(value.className).toContain('tabular-nums')
  })

  it('keeps the control slot from being squeezed by long labels', () => {
    const { container } = render(
      <SettingRow label="A very long label that would otherwise squeeze the control">
        <button type="button">toggle</button>
      </SettingRow>,
    )
    const label = screen.getByText(/A very long label/)
    expect(label.parentElement?.className).toContain('min-w-0')
    const slot = screen.getByRole('button', { name: 'toggle' }).parentElement as HTMLElement
    expect(slot.className).toContain('shrink-0')
    expect(container.firstElementChild?.className).toContain('items-center')
  })

  it('aligns to the top when the row carries a description', () => {
    const { container } = render(<SettingRow label="Immersive" description="Hide chrome" align="start" />)
    expect((container.firstElementChild as HTMLElement).className).toContain('items-start')
  })
})
