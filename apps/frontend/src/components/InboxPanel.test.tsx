import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxPanel } from './InboxPanel'
import { useInboxStore } from '@/stores/useInboxStore'
import type { AgentInboxMessage } from '@/types'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  markReadBatch: vi.fn(),
  markRead: vi.fn(),
  remove: vi.fn(),
  get: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: {
    inbox: {
      list: apiMocks.list,
      markReadBatch: apiMocks.markReadBatch,
      markRead: apiMocks.markRead,
      remove: apiMocks.remove,
      get: apiMocks.get,
      unreadCount: vi.fn(async () => ({ ok: true, unreadCount: 0 })),
      assetUrl: vi.fn(),
      fetchAsset: vi.fn(),
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'inbox.title': 'Inbox',
        'inbox.empty': 'No messages',
        'inbox.unreadDot': 'Unread',
        'inbox.markAllRead': 'Mark all read',
        'inbox.markRead': 'Mark read',
        'inbox.delete': 'Delete',
        'inbox.loadMore': 'Load more',
        'inbox.jump': 'Jump',
        'inbox.noPreview': 'Pick a message',
        'common.close': 'Close',
        'common.back': 'Back',
        'common.loading': 'Loading',
      }
      return map[key] || key
    },
  }),
}))
vi.mock('./InboxPreview', () => ({
  InboxPreview: ({ messageId }: { messageId: string }) => React.createElement('div', null, `preview:${messageId}`),
}))

function message(partial: Partial<AgentInboxMessage>): AgentInboxMessage {
  return {
    id: 'm1',
    type: 'text',
    title: 'hello world',
    source: { agent: 'codex' },
    route: {},
    createdAt: '2026-09-26T10:00:00.000Z',
    readBy: [],
    ...partial,
  }
}
function resetInboxStore() {
  useInboxStore.setState({
    deviceId: 'dev-1',
    messages: [],
    unreadCount: 0,
    nextCursor: null,
    listLoaded: true,
    tabs: [],
    activeTabId: null,
    panelOpen: true,
  })
}

describe('InboxPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    // 面板挂载即 refreshInboxList，mock 回源当前镜像避免清空夹具数据
    apiMocks.list.mockImplementation(async () => {
      const state = useInboxStore.getState()
      return {
        ok: true,
        messages: state.messages,
        nextCursor: state.nextCursor,
        unreadCount: state.unreadCount,
        total: state.messages.length,
      }
    })
    apiMocks.markReadBatch.mockResolvedValue({ ok: true, changed: 1 })
    apiMocks.markRead.mockResolvedValue({ ok: true, changed: 1 })
    apiMocks.remove.mockResolvedValue({ ok: true, removed: 1 })
    resetInboxStore()
  })

  it('lists messages with unread dot and opens preview + marks read on click (mobile)', async () => {
    const onPreview = vi.fn()
    useInboxStore.setState({
      messages: [message({ id: 'm1' }), message({ id: 'm2', title: 'read one', readBy: ['dev-1'] })],
      unreadCount: 1,
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} onPreview={onPreview} />)
    // 等挂载刷新落盘（setList 整体替换 messages），否则点击标记会被回源快照覆盖
    await act(async () => {})
    const row = screen.getByText('hello world')
    expect(row.closest('div')?.parentElement?.querySelector('.bg-accent')).toBeTruthy()
    fireEvent.click(row)
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(useInboxStore.getState().activeTabId).toBe('m1')
    await waitFor(() => expect(apiMocks.markReadBatch).toHaveBeenCalledWith(['m1'], 'dev-1'))
    await waitFor(() =>
      expect(useInboxStore.getState().messages.find((item) => item.id === 'm1')?.readBy).toContain('dev-1'),
    )
  })

  it('does not re-mark a message already read on this device', () => {
    useInboxStore.setState({ messages: [message({ id: 'm1', readBy: ['dev-1'] })] })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} onPreview={vi.fn()} />)
    fireEvent.click(screen.getByText('hello world'))
    expect(apiMocks.markReadBatch).not.toHaveBeenCalled()
    expect(apiMocks.markRead).not.toHaveBeenCalled()
  })

  it('deletes a message via REST and removes it from the mirror', async () => {
    useInboxStore.setState({ messages: [message({ id: 'm1' })], unreadCount: 1 })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith(['m1']))
    expect(useInboxStore.getState().messages).toHaveLength(0)
    expect(useInboxStore.getState().unreadCount).toBe(0)
  })

  it('marks every unread message read from the header action', async () => {
    useInboxStore.setState({
      messages: [message({ id: 'a' }), message({ id: 'b', readBy: ['dev-1'] }), message({ id: 'c' })],
      unreadCount: 2,
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => expect(apiMocks.markReadBatch).toHaveBeenCalled())
    const [idsArg, deviceArg] = apiMocks.markReadBatch.mock.calls[0]
    expect([...idsArg].sort()).toEqual(['a', 'c'])
    expect(deviceArg).toBe('dev-1')
    expect(useInboxStore.getState().unreadCount).toBe(0)
  })

  it('loads the next page through cursor pagination', async () => {
    useInboxStore.setState({ messages: [message({ id: 'm1' })], nextCursor: 'cursor-x' })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'cursor-x' })))
  })

  it('invokes onJump only for routed messages', () => {
    const onJump = vi.fn()
    useInboxStore.setState({
      messages: [
        message({ id: 'routed', route: { hostId: 'local', sessionName: 'dev', tmuxPaneId: '%4' } }),
        message({ id: 'plain' }),
      ],
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} onJump={onJump} />)
    expect(screen.getAllByRole('button', { name: 'Jump' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }))
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: 'routed' }))
  })

  it('opens a preview tab inside the desktop dialog', async () => {
    useInboxStore.setState({ messages: [message({ id: 'm1' })] })
    render(<InboxPanel mode="desktop" onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('hello world'))
    await waitFor(() => expect(screen.getByText('preview:m1')).toBeTruthy())
    expect(useInboxStore.getState().tabs.map((tab) => tab.id)).toEqual(['m1'])
    // 关掉 tab 回到空预览态
    const tabClose = screen.getAllByRole('button', { name: 'Close' }).find((button) => button.closest('.group'))
    expect(tabClose).toBeTruthy()
    fireEvent.click(tabClose!)
    expect(useInboxStore.getState().tabs).toHaveLength(0)
    expect(screen.getByText('Pick a message')).toBeTruthy()
  })
})
