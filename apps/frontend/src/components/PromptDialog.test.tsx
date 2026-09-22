import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'
import { PromptDialog } from './PromptDialog'

const renderDialog = (onConfirm = vi.fn(), onCancel = vi.fn()) => {
  render(
    React.createElement(PromptDialog, {
      open: true,
      title: 'Rename window',
      defaultValue: 'old',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      onConfirm,
      onCancel,
    }),
  )
  return { onConfirm, onCancel }
}

describe('PromptDialog', () => {
  it('ignores Enter and Escape during IME composition', () => {
    const { onConfirm, onCancel } = renderDialog()
    const input = screen.getByDisplayValue('old')
    // 拼音选词键（isComposing / keyCode 229 两种上报路径都覆盖）
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229, isComposing: true })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('confirms the typed value on a normal Enter', () => {
    const { onConfirm } = renderDialog()
    const input = screen.getByDisplayValue('old')
    fireEvent.change(input, { target: { value: '新窗口' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith('新窗口')
  })
})
