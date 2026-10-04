import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SessionTemplates } from './SessionTemplates'
import { I18nProvider } from '@/i18n'

vi.mock('@/hooks/useApi', () => ({
  useSessionTemplates: () => ({ data: { templates: [] } }),
  useUpdateSessionTemplates: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const renderDialog = (onSelect = vi.fn()) =>
  render(React.createElement(I18nProvider, null, React.createElement(SessionTemplates, { onSelect, onClose: vi.fn() })))
const importFile = (content: string) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File([content], 'layout.json', { type: 'application/json' })
  fireEvent.change(input, { target: { files: [file] } })
}

afterEach(cleanup)

describe('SessionTemplates layout import', () => {
  it('imports a valid layout file and forwards it to the create flow', async () => {
    const onSelect = vi.fn()
    renderDialog(onSelect)
    importFile(
      JSON.stringify({
        kind: 'tmuxgo.session-layout',
        version: 1,
        name: 'dev',
        windows: [{ name: 'main', panes: [{ command: 'vim', cwd: '/repo' }] }],
      }),
    )
    await act(async () => {})
    expect(onSelect).toHaveBeenCalledTimes(1)
    const template = onSelect.mock.calls[0][0]
    expect(template.name).toBe('dev')
    expect(template.layout.windows[0].panes[0].command).toBe('vim')
  })
  it('shows an inline error and does not forward invalid files', async () => {
    const onSelect = vi.fn()
    renderDialog(onSelect)
    importFile(JSON.stringify({ version: 9, windows: [{ name: 'w', panes: [{}] }] }))
    await act(async () => {})
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText(/Unsupported layout version/)).toBeTruthy()
  })
})
