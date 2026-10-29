import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EditorShortcutsDialog } from './EditorShortcutsDialog'
import { I18nProvider } from '@/i18n'

function renderDialog(overrides: Partial<React.ComponentProps<typeof EditorShortcutsDialog>> = {}) {
  const props: React.ComponentProps<typeof EditorShortcutsDialog> = { open: true, onClose: vi.fn(), ...overrides }
  render(
    <I18nProvider>
      <EditorShortcutsDialog {...props} />
    </I18nProvider>,
  )
  return props
}

describe('EditorShortcutsDialog', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('editor-shortcuts')).toBeNull()
  })

  it('groups the commands from the registry', () => {
    renderDialog()
    const dialog = screen.getByTestId('editor-shortcuts')
    for (const label of ['导航', '编辑', '视图', '标签与分屏']) expect(dialog.textContent).toContain(label)
    expect(dialog.textContent).toContain('转到行/列…')
    // 键位按平台渲染：jsdom 里按 Ctrl 显示（非 mac）
    expect(dialog.textContent).toMatch(/Ctrl\+G/)
  })

  it('closes from the header button and the backdrop', () => {
    const props = renderDialog()
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('editor-shortcuts').parentElement!)
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})
