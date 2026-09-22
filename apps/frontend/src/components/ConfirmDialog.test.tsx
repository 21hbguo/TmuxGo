import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

const baseProps = {
  open: true,
  title: 'End session',
  message: 'This cannot be undone.',
  confirmLabel: 'End session',
  cancelLabel: 'Cancel',
  tone: 'danger' as const,
  onCancel: vi.fn(),
}

function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  return render(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} {...props} />)
}

describe('ConfirmDialog', () => {
  it('focuses the cancel (safe) button by default and renders item list', async () => {
    renderDialog({ items: ['alpha', 'beta'] })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('submits only once for rapid double clicks while confirm is pending', async () => {
    let resolveConfirm: () => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve
        }),
    )
    renderDialog({ onConfirm })
    const confirmButton = screen.getByRole('button', { name: 'End session' })
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true)
    await act(async () => resolveConfirm())
  })

  it('cancels on Escape and traps Tab inside the dialog', async () => {
    const onCancel = vi.fn()
    renderDialog({ onCancel })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    const dialog = screen.getByRole('dialog')
    // Tab on last focusable (confirm) wraps to first (cancel)；Shift+Tab on cancel 也回绕
    fireEvent.keyDown(dialog, { key: 'Tab' })
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('restores focus to the trigger element after close', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const { rerender } = render(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} open={true} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    rerender(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} open={false} />)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    document.body.removeChild(trigger)
  })
})
