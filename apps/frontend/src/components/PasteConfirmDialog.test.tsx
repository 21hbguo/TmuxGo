import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { vi } from 'vitest'
import { PasteConfirmDialog } from './PasteConfirmDialog'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => {
    if (key === 'paste.title') return 'Confirm paste'
    if (key === 'paste.manualTitle') return 'Paste manually'
    if (key === 'paste.manualDesc') return 'Paste into box'
    if (key === 'paste.cancel') return 'Cancel'
    if (key === 'paste.retryPermission') return 'Retry Permission'
    if (key === 'paste.escapePaste') return 'Escape Paste'
    if (key === 'paste.send') return 'Send'
    return key
  } }),
}))

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
  it('sends on enter and keeps shift enter as newline', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    function DialogHarness() {
      const [text, setText] = React.useState('printf ok')
      return React.createElement(PasteConfirmDialog, {
        open: true,
        text,
        meta: [],
        onTextChange: setText,
        onSend,
        onEscapeSend: vi.fn(),
        onCancel: vi.fn(),
      })
    }
    render(React.createElement(DialogHarness))
    const textarea = screen.getByRole('textbox')
    await waitFor(() => expect(document.activeElement).toBe(textarea))
    await waitFor(() => expect(textarea).toHaveProperty('selectionStart', 'printf ok'.length))
    await waitFor(() => expect(textarea).toHaveProperty('selectionEnd', 'printf ok'.length))
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onSend).toHaveBeenCalledTimes(0)
    expect(textarea).toHaveValue('printf ok\n')
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
  })
  it('renders manual paste mode', () => {
    render(
      React.createElement(PasteConfirmDialog, {
        open: true,
        text: '',
        meta: ['clipboard unavailable'],
        mode: 'manual',
        onSend: vi.fn(),
        onEscapeSend: vi.fn(),
        onCancel: vi.fn(),
      })
    )
    expect(screen.getByText('Paste manually')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry Permission' })).toBeInTheDocument()
  })
})
