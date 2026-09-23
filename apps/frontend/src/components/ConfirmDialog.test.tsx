import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

const baseProps = {
  open: true,
  title: 'End session',
  message: 'This cannot be undone.',
  confirmLabel: 'End session',
  cancelLabel: 'Cancel',
  tone: 'danger' as const,
  onCancel: vi.fn(),
}

function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  return render(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} {...props} />)
}

describe('ConfirmDialog', () => {
  it('focuses the cancel (safe) button by default and renders item list', async () => {
    renderDialog({ items: ['alpha', 'beta'] })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('submits only once for rapid double clicks while confirm is pending', async () => {
    let resolveConfirm: () => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve
        }),
    )
    renderDialog({ onConfirm })
    const confirmButton = screen.getByRole('button', { name: 'End session' })
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true)
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
    renderDialog({ onConfirm })
    const confirmButton = screen.getByRole('button', { name: 'End session' })
    fireEvent.click(confirmButton)
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true)
    // 拒绝被组件吞掉（不产生未处理拒绝链）并恢复执行态
    await act(async () => rejectConfirm(new Error('boom')))
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it('stays compatible with a synchronous onConfirm', () => {
    const onConfirm = vi.fn()
    renderDialog({ onConfirm })
    const confirmButton = screen.getByRole('button', { name: 'End session' })
    fireEvent.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps Tab and Shift+Tab inside the dialog while busy', async () => {
    let resolveConfirm: () => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve
        }),
    )
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })
    const dialog = screen.getByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    // busy 时按钮全 disabled，焦点泊到容器上
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    // 正/反向 Tab 均被 preventDefault，焦点不离开弹窗
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(dialog)
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(dialog)
    // busy 中 Escape 不触发取消
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => resolveConfirm())
  })

  it('resumes normal Tab cycling after the pending confirm settles', async () => {
    let rejectConfirm: (err: unknown) => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectConfirm = reject
        }),
    )
    renderDialog({ onConfirm })
    const dialog = screen.getByRole('dialog')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    await act(async () => rejectConfirm(new Error('boom')))
    // 失败后回到普通循环：焦点泊在容器（不在可聚焦序列）→ Tab 归位到首控件
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(cancel)
    // 首控件 Shift+Tab 回绕到末位，末位 Tab 回绕到首
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'End session' }))
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(cancel)
  })

  it('cancels on Escape and traps Tab inside the dialog', async () => {
    const onCancel = vi.fn()
    renderDialog({ onCancel })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    const dialog = screen.getByRole('dialog')
    // Tab on last focusable (confirm) wraps to first (cancel)；Shift+Tab on cancel 也回绕
    fireEvent.keyDown(dialog, { key: 'Tab' })
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('restores focus to the trigger element after close', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const { rerender } = render(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} open={true} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    rerender(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} open={false} />)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    document.body.removeChild(trigger)
  })

  it('does not restore focus to a trigger that was removed from the DOM', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const { rerender } = render(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} open={true} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    document.body.removeChild(trigger)
    rerender(<ConfirmDialog {...baseProps} onConfirm={vi.fn()} open={false} />)
    // 触发元素已不存在 → 跳过回焦，焦点不落到终端等错误目标
    expect(document.activeElement).not.toBe(trigger)
    expect(document.activeElement).toBe(document.body)
  })
})
