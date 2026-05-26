import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipboardController } from './ClipboardController'

const pushToast = vi.fn()
const readClipboardTextOnly = vi.fn()
const writeClipboardText = vi.fn()

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: ((selector: any) => selector({ pushToast })) as any,
}))
vi.mock('@/lib/clipboard-text', () => ({
  readClipboardTextOnly: (...args: any[]) => readClipboardTextOnly(...args),
  writeClipboardText: (...args: any[]) => writeClipboardText(...args),
}))
vi.mock('@/lib/terminal-selection', () => ({
  requestTerminalSelection: vi.fn(),
}))

describe('ClipboardController', () => {
  beforeEach(() => {
    pushToast.mockReset()
    readClipboardTextOnly.mockReset()
    writeClipboardText.mockReset()
  })

  it('confirms native multi-line paste instead of sending it directly', async () => {
    const terminalInput = vi.fn()
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'echo a\necho b', source: 'system' } }))
    expect(await screen.findByText('Confirm paste')).toBeInTheDocument()
    expect(screen.getByText('multi-line')).toBeInTheDocument()
    expect(terminalInput).not.toHaveBeenCalled()
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })

  it('sends native single-line paste directly', () => {
    const terminalInput = vi.fn()
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'printf ok', source: 'system' } }))
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(terminalInput.mock.calls[0][0].detail.data).toBe('printf ok')
    expect(screen.queryByText('Confirm paste')).not.toBeInTheDocument()
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })

  it('sends confirmed paste only after user action', async () => {
    const user = userEvent.setup()
    const terminalInput = vi.fn()
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'echo a\necho b', source: 'system' } }))
    await user.click(await screen.findByRole('button', { name: 'Send' }))
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(terminalInput.mock.calls[0][0].detail.data).toBe('echo a\necho b')
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })
})
