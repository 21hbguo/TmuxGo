import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { vi } from 'vitest'
import { PasteConfirmDialog } from './PasteConfirmDialog'

describe('PasteConfirmDialog', () => {
  it('renders metadata and invokes send actions', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onEscapeSend = vi.fn()
    const onCancel = vi.fn()
    render(
      React.createElement(PasteConfirmDialog, {
        open: true,
        text: 'echo a\necho b',
        meta: ['multi-line', '12 chars'],
        onSend,
        onEscapeSend,
        onCancel,
      })
    )
    expect(screen.getByText('Confirm paste')).toBeInTheDocument()
    expect(screen.getByText('multi-line')).toBeInTheDocument()
    expect(screen.getByText('12 chars')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Escape Paste' }))
    expect(onEscapeSend).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(1)
  })
})
