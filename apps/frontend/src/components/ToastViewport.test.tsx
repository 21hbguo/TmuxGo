import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastViewport } from './ToastViewport'
import { useConsoleStore } from '@/stores/useConsoleStore'

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const makeToast = (id: string, type: 'success' | 'error' | 'info' = 'info', durationMs?: number) => ({
  id,
  type,
  message: `msg-${id}`,
  durationMs,
})

function pushToastState(toast: ReturnType<typeof makeToast>) {
  act(() => {
    useConsoleStore.setState((state) => ({ toasts: [...state.toasts, toast] }))
  })
}

describe('ToastViewport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useConsoleStore.setState({ toasts: [] })
    render(<ToastViewport />)
  })
  afterEach(() => {
    act(() => {
      useConsoleStore.setState({ toasts: [] })
    })
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('keeps error toasts longer and allows manual dismiss', () => {
    pushToastState(makeToast('e1', 'error'))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('msg-e1')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('auto-dismisses error toasts after the extended duration', () => {
    pushToastState(makeToast('e2', 'error'))
    act(() => {
      vi.advanceTimersByTime(7999)
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not reset existing toast timers when a new toast arrives', () => {
    pushToastState(makeToast('a'))
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    pushToastState(makeToast('b'))
    act(() => {
      vi.advanceTimersByTime(799)
    })
    expect(screen.getByText('msg-a')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('msg-a')).toBeNull()
    expect(screen.getByText('msg-b')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByText('msg-b')).toBeNull()
  })

  it('honors explicit durationMs for error toasts', () => {
    pushToastState(makeToast('e3', 'error', 1200))
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
