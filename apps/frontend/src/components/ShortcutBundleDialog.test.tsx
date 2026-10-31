import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ShortcutBundleDialog } from './ShortcutBundleDialog'
import { I18nProvider } from '@/i18n'
import type { CustomShortcut } from '@/types'

const shortcuts: CustomShortcut[] = [
  {
    id: 'a',
    label: '均匀布局',
    steps: [
      { type: 'keys', keys: 'Ctrl+B' },
      { type: 'keys', keys: 'Alt+5' },
    ],
  },
]

const renderDialog = (props: React.ComponentProps<typeof ShortcutBundleDialog>) =>
  render(React.createElement(I18nProvider, null, React.createElement(ShortcutBundleDialog, props)))

describe('ShortcutBundleDialog', () => {
  it('renders a versioned bundle for the current shortcuts', async () => {
    renderDialog({ open: true, shortcuts, onImport: vi.fn(), onNotify: vi.fn(), onClose: vi.fn() })
    await act(async () => {})
    const textarea = screen.getByLabelText('导出') as HTMLTextAreaElement
    const bundle = JSON.parse(textarea.value)
    expect(bundle.kind).toBe('tmuxgo.shortcuts')
    expect(bundle.version).toBe(1)
    expect(bundle.shortcuts[0]).toEqual({
      label: '均匀布局',
      repeat: false,
      steps: [
        { type: 'keys', keys: 'Ctrl+B' },
        { type: 'keys', keys: 'Alt+5' },
      ],
    })
  })
  it('imports pasted json in merge mode and reports the result', async () => {
    const onImport = vi.fn(() => ({ added: 1, skipped: 0 }))
    const onNotify = vi.fn()
    const onClose = vi.fn()
    renderDialog({ open: true, shortcuts, onImport, onNotify, onClose })
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('导入'), {
      target: {
        value: JSON.stringify({
          kind: 'tmuxgo.shortcuts',
          version: 1,
          shortcuts: [{ label: '新宏', steps: [{ type: 'keys', keys: 'ctrl+l' }] }],
        }),
      },
    })
    expect(screen.getByText('可导入 1 个')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    expect(onImport).toHaveBeenCalledWith(
      [{ label: '新宏', repeat: false, steps: [{ type: 'keys', keys: 'Ctrl+L' }] }],
      'merge',
    )
    expect(onNotify).toHaveBeenCalledWith('已导入 1 个（跳过重复 0 个）', 'success')
    expect(onClose).toHaveBeenCalled()
  })
  it('shows why entries are rejected instead of failing the whole file', async () => {
    renderDialog({ open: true, shortcuts, onImport: vi.fn(), onNotify: vi.fn(), onClose: vi.fn() })
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('导入'), {
      target: {
        value: JSON.stringify([
          { label: '好', steps: [{ type: 'keys', keys: 'Ctrl+A' }] },
          { label: '坏', steps: [{ type: 'keys', keys: 'Ctrl+1' }] },
        ]),
      },
    })
    expect(screen.getByText('1 条无法导入')).toBeTruthy()
    expect(screen.getByText('第 2 条：按键「Ctrl+1」没有终端编码')).toBeTruthy()
    expect(screen.getByText('可导入 1 个')).toBeTruthy()
  })
})
