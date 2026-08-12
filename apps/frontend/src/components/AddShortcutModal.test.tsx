import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AddShortcutModal } from './AddShortcutModal'
import { I18nProvider } from '@/i18n'

const renderModal = (props: { onSave: (data: any) => void; onClose: () => void; isMobile?: boolean; initialShortcut?: any }) =>
  render(React.createElement(I18nProvider, null, React.createElement(AddShortcutModal, props)))

describe('AddShortcutModal macro validation', () => {
  it('disables save while a text step is empty and enables after typing', async () => {
    const onSave = vi.fn()
    renderModal({ onSave, onClose: vi.fn(), initialShortcut: { id: 'x', label: 'X', steps: [{ type: 'text', text: '', appendEnter: false }] } })
    await act(async () => {})
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/快速发送到终端/), { target: { value: 'echo ok' } })
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })
  it('disables save while a wait step has no duration', async () => {
    renderModal({ onSave: vi.fn(), onClose: vi.fn(), initialShortcut: { id: 'y', label: 'Y', steps: [{ type: 'wait', ms: undefined }] } })
    await act(async () => {})
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('等待毫秒数'), { target: { value: '500' } })
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('edits a macro keys step with a picker on mobile', async () => {
    const onSave = vi.fn()
    renderModal({ onSave, onClose: vi.fn(), isMobile: true, initialShortcut: { id: 'z', label: 'Z', steps: [{ type: 'keys', keys: '' }] } })
    await act(async () => {})
    const combos = screen.getAllByRole('combobox') as HTMLSelectElement[]
    fireEvent.change(combos[combos.length - 1], { target: { value: 'A' } })
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledWith({ label: 'Z', steps: [{ type: 'keys', keys: 'A' }], repeat: false })
  })
  it('re-syncs the key picker after reordering macro steps on mobile', async () => {
    renderModal({ onSave: vi.fn(), onClose: vi.fn(), isMobile: true, initialShortcut: { id: 'r', label: 'R', steps: [{ type: 'keys', keys: 'Ctrl+A' }, { type: 'keys', keys: 'Ctrl+B' }] } })
    await act(async () => {})
    const combos = () => screen.getAllByRole('combobox') as HTMLSelectElement[]
    expect(combos()[1].value).toBe('A')
    expect(combos()[3].value).toBe('B')
    fireEvent.click(screen.getAllByRole('button', { name: '上移' })[1])
    expect(combos()[1].value).toBe('B')
    expect(combos()[3].value).toBe('A')
  })
  it('saves repeat flag when hold-to-repeat is checked', async () => {
    const onSave = vi.fn()
    renderModal({ onSave, onClose: vi.fn(), initialShortcut: { id: 'r', label: 'R', steps: [{ type: 'keys', keys: 'PageUp' }] } })
    await act(async () => {})
    fireEvent.click(screen.getByLabelText('长按持续触发'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledWith({ label: 'R', steps: [{ type: 'keys', keys: 'PageUp' }], repeat: true })
  })
  it('keeps repeat unchecked by default and restores it when editing', async () => {
    const onSave = vi.fn()
    renderModal({ onSave, onClose: vi.fn(), initialShortcut: { id: 'n', label: 'N', steps: [{ type: 'keys', keys: 'PageDown' }] } })
    await act(async () => {})
    const checkbox = screen.getByLabelText('长按持续触发') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledWith({ label: 'N', steps: [{ type: 'keys', keys: 'PageDown' }], repeat: false })
    cleanup()
    renderModal({ onSave, onClose: vi.fn(), initialShortcut: { id: 'e', label: 'E', steps: [{ type: 'keys', keys: 'PageUp' }], repeat: true } })
    await act(async () => {})
    expect((screen.getByLabelText('长按持续触发') as HTMLInputElement).checked).toBe(true)
  })
})
