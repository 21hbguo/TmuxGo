import { act, render, screen } from '@testing-library/react'
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
    act(() => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'echo a\necho b', source: 'system' } }))
    })
    expect(await screen.findByText('Confirm paste')).toBeInTheDocument()
    expect(screen.getByText('multi-line')).toBeInTheDocument()
    expect(terminalInput).not.toHaveBeenCalled()
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })

  it('confirms native single-line paste instead of sending it directly', async () => {
    const terminalInput = vi.fn()
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    act(() => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'printf ok', source: 'system' } }))
    })
    expect(await screen.findByText('Confirm paste')).toBeInTheDocument()
    expect(screen.getByDisplayValue('printf ok')).toBeInTheDocument()
    expect(terminalInput).not.toHaveBeenCalled()
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })

  it('sends confirmed paste only after user action', async () => {
    const user = userEvent.setup()
    const terminalInput = vi.fn()
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    act(() => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'echo a\necho b', source: 'system' } }))
    })
    await user.click(await screen.findByRole('button', { name: 'Send' }))
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(terminalInput.mock.calls[0][0].detail.data).toBe('echo a\necho b')
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })

  it('reads clipboard requests into the paste editor before sending', async () => {
    const user = userEvent.setup()
    const terminalInput = vi.fn()
    readClipboardTextOnly.mockResolvedValue({ text: 'printf clipboard', source: 'system', unavailable: false })
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    await act(async () => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste'))
      await Promise.resolve()
    })
    const textarea = await screen.findByDisplayValue('printf clipboard')
    expect(terminalInput).not.toHaveBeenCalled()
    await user.clear(textarea)
    await user.type(textarea, 'printf edited')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(terminalInput.mock.calls[0][0].detail.data).toBe('printf edited')
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })

  it('coalesces repeated paste requests until send is clicked', async () => {
    const user = userEvent.setup()
    const terminalInput = vi.fn()
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    act(() => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'printf once', source: 'system' } }))
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'printf once', source: 'system' } }))
    })
    expect(await screen.findByText('Confirm paste')).toBeInTheDocument()
    expect(terminalInput).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(terminalInput.mock.calls[0][0].detail.data).toBe('printf once')
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })
})
