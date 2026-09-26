import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { useInboxStore } from '@/stores/useInboxStore'
import { useInboxSync } from './useInbox'

const apiMocks = vi.hoisted(() => ({
  inboxList: vi.fn(),
  inboxUnreadCount: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: {
    inbox: {
      get: vi.fn(),
      list: apiMocks.inboxList,
      unreadCount: apiMocks.inboxUnreadCount,
      markRead: vi.fn(),
      markReadBatch: vi.fn(),
      remove: vi.fn(),
      assetUrl: vi.fn(),
      fetchAsset: vi.fn(),
    },
  },
}))

function resetStore() {
  useInboxStore.setState({
    deviceId: 'dev-1',
    messages: [],
    unreadCount: 0,
    nextCursor: null,
    listLoaded: true,
    tabs: [],
    activeTabId: null,
    panelOpen: false,
  })
}

describe('useInboxSync', () => {
  beforeEach(() => {
    window.localStorage.clear()
    apiMocks.inboxList.mockReset().mockResolvedValue({ messages: [], nextCursor: null, unreadCount: 0 })
    apiMocks.inboxUnreadCount.mockReset().mockResolvedValue({ unreadCount: 0 })
    resetStore()
  })

  it('WS 断线期间事件丢失：reconnected 后按 REST 对账刷新角标', async () => {
    apiMocks.inboxUnreadCount.mockResolvedValue({ unreadCount: 0 })
    renderHook(() => useInboxSync())
    // 后台丢了两条推送，服务端 unread=2；重连事件应对账出新角标
    apiMocks.inboxList.mockResolvedValue({
      messages: [
        {
          id: 'lost-1',
          type: 'text',
          title: 'late',
          source: {},
          route: {},
          createdAt: '2026-09-26T10:00:00.000Z',
          readBy: [],
        },
      ],
      nextCursor: null,
      unreadCount: 2,
    })
    await act(async () => {
      emitStreamEvent(STREAM_EVENT.reconnected)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(apiMocks.inboxList).toHaveBeenCalled()
    expect(useInboxStore.getState().unreadCount).toBe(2)
    expect(useInboxStore.getState().messages.map((m) => m.id)).toContain('lost-1')
  })

  it('回前台触发对账，且短时间重复 reconcile 会被去抖', async () => {
    renderHook(() => useInboxSync())
    apiMocks.inboxList.mockClear()
    await act(async () => {
      emitStreamEvent(STREAM_EVENT.reconnected)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(apiMocks.inboxList).toHaveBeenCalledTimes(1)
    // 2s 内再次触发（可见性切换/重连风暴）不再重复拉取
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      emitStreamEvent(STREAM_EVENT.reconnected)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(apiMocks.inboxList).toHaveBeenCalledTimes(1)
  })

  it('live 事件仍即时更新 unreadCount', async () => {
    renderHook(() => useInboxSync())
    act(() => {
      emitStreamEvent(STREAM_EVENT.inboxMessageCreated, {
        type: 'inbox_message_created',
        message: {
          id: 'live-1',
          type: 'text',
          title: 'hi',
          source: {},
          route: {},
          createdAt: '2026-09-26T10:00:00.000Z',
          readBy: [],
        },
      })
    })
    expect(useInboxStore.getState().unreadCount).toBe(1)
  })
})
