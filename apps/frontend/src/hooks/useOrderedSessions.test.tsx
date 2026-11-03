import { render, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOrderedSessions } from './useOrderedSessions'
import type { Session } from '@/types'
const getMock = vi.fn()
const updateMock = vi.fn()
const useSessionsMock = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    preferences: {
      get: (...args: unknown[]) => getMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}))
vi.mock('./useApi', () => ({
  useSessions: (...args: unknown[]) => useSessionsMock(...args),
}))
function TestComponent({ hostId, onRender }: { hostId: string; onRender: (sessions: Session[]) => void }) {
  const query = useOrderedSessions(hostId)
  onRender(query.data || [])
  return React.createElement('div')
}
describe('useOrderedSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    getMock.mockResolvedValue({ sessionOrders: [], sessionOrdersUpdatedAt: '' })
    updateMock.mockResolvedValue({})
  })
  it('does not push identical session order after hydration', async () => {
    const onRender = vi.fn()
    useSessionsMock.mockReturnValue({
      data: [
        { id: 'session-a', name: 'a', windowCount: 1 },
        { id: 'session-b', name: 'b', windowCount: 1 },
      ],
      isFetched: true,
    })
    localStorage.setItem('tmuxgo-session-order:local', JSON.stringify(['session-a', 'session-b']))
    localStorage.setItem('tmuxgo-session-order-updated-at:local', '2026-06-03T00:00:00.000Z')
    render(React.createElement(TestComponent, { hostId: 'local', onRender }))
    await waitFor(() => expect(onRender).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateMock).not.toHaveBeenCalled()
  })

  // 切 host 的首取窗口里 useSessions 会拿上一个 host 的缓存占位（keepPreviousData）：
  // 这段时间的列表不属于当前 host，任何「按 host 落盘」的排序动作都必须跳过，
  // 否则 host-b 的排序偏好会被写成 host-a 的 session id
  it('ignores placeholder data from the previous host when persisting the order', async () => {
    const onRender = vi.fn()
    useSessionsMock.mockReturnValue({
      data: [{ id: 'session-from-other-host', name: 'other', windowCount: 1 }],
      isFetched: true,
      isPlaceholderData: true,
    })
    localStorage.setItem('tmuxgo-session-order:host-b', JSON.stringify([]))
    render(React.createElement(TestComponent, { hostId: 'host-b', onRender }))
    await waitFor(() => expect(onRender).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateMock).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('tmuxgo-session-order:host-b') || '[]')).toEqual([])
    expect(localStorage.getItem('tmuxgo-session-order:host-b')).toBe(JSON.stringify([]))
  })
})
