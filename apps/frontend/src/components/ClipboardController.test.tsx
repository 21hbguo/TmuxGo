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
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => {
    if (key === 'paste.title') return 'Confirm paste'
    if (key === 'paste.manualTitle') return 'Paste manually'
    if (key === 'paste.manualDesc') return 'Paste into box'
    if (key === 'paste.cancel') return 'Cancel'
    if (key === 'paste.retryPermission') return 'Retry Permission'
    if (key === 'paste.escapePaste') return 'Escape Paste'
    if (key === 'paste.send') return 'Send'
    if (key === 'clipboard.meta.multiline') return 'multi-line'
    if (key === 'clipboard.meta.controlChars') return 'control chars'
    if (key === 'clipboard.meta.appClipboard') return 'app clipboard'
    if (key === 'clipboard.meta.unavailable') return 'clipboard unavailable'
    return key
  } }),
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
    expect(screen.getByText('printf ok')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
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
  it('does not blur an active terminal ime composition after paste send focus restore', async () => {
    const user = userEvent.setup()
    const terminalInput = vi.fn()
    const terminal = document.createElement('div')
    const helper = document.createElement('textarea')
    terminal.setAttribute('data-terminal', 'true')
    terminal.tabIndex = 0
    helper.className = 'xterm-helper-textarea'
    terminal.appendChild(helper)
    document.body.appendChild(terminal)
    const blur = vi.fn()
    helper.addEventListener('blur', blur)
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    act(() => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'printf ok', source: 'system' } }))
    })
    await user.click(await screen.findByRole('button', { name: 'Send' }))
    helper.focus()
    helper.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 130))
    })
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(blur).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(helper)
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
    terminal.remove()
  })

  it('reads clipboard requests into confirmation before sending', async () => {
    const user = userEvent.setup()
    const terminalInput = vi.fn()
    readClipboardTextOnly.mockResolvedValue({ text: 'printf clipboard', source: 'system', unavailable: false })
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    await act(async () => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste'))
      await Promise.resolve()
    })
    expect(await screen.findByText('printf clipboard')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(terminalInput).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(terminalInput.mock.calls[0][0].detail.data).toBe('printf clipboard')
    window.removeEventListener('tmuxgo-terminal-input', terminalInput)
  })
  it('keeps manual clipboard fallback editable', async () => {
    const user = userEvent.setup()
    const terminalInput = vi.fn()
    readClipboardTextOnly.mockResolvedValue({ text: '', source: 'empty', unavailable: true })
    window.addEventListener('tmuxgo-terminal-input', terminalInput)
    render(React.createElement(ClipboardController))
    await act(async () => {
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste'))
      await Promise.resolve()
    })
    const textarea = await screen.findByRole('textbox')
    await user.type(textarea, 'printf manual')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(terminalInput).toHaveBeenCalledTimes(1)
    expect(terminalInput.mock.calls[0][0].detail.data).toBe('printf manual')
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
