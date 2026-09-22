import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PromptDialog } from './PromptDialog'

function renderDialog(props: Partial<Parameters<typeof PromptDialog>[0]> = {}) {
  return render(
    <PromptDialog
      open
      title="Rename window"
      defaultValue="main"
      confirmLabel="Confirm"
      cancelLabel="Cancel"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />,
  )
}

describe('PromptDialog', () => {
  it('submits only once for rapid Enter/click repeats while confirm is pending', async () => {
    let resolveConfirm: () => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve
        }),
    )
    renderDialog({ onConfirm })
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith('main')
    // busy 中不允许取消
    fireEvent.keyDown(input, { key: 'Escape' })
    await act(async () => resolveConfirm())
  })

  it('recovers from a rejected confirm and allows retry', async () => {
    let rejectConfirm: (err: unknown) => void = () => {}
    const onConfirm = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectConfirm = reject
          }),
      )
      .mockResolvedValueOnce(undefined)
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => rejectConfirm(new Error('boom')))
    // 拒绝后恢复执行态，可重试；Escape 也恢复可用
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(2)
    await act(async () => {})
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores Enter and Escape during IME composition', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })
    const input = screen.getByRole('textbox')
    // 拼音选词键（isComposing / keyCode 229 两种上报路径都覆盖）
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229, isComposing: true })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('confirms the typed value on a normal Enter', () => {
    const onConfirm = vi.fn()
    renderDialog({ onConfirm })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '新窗口' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith('新窗口')
  })
})
