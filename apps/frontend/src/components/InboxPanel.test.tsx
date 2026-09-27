import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxPanel } from './InboxPanel'
import { useInboxStore } from '@/stores/useInboxStore'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { AgentInboxMessage, InboxViewFilter } from '@/types'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  markReadBatch: vi.fn(),
  markRead: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  purge: vi.fn(),
  archive: vi.fn(),
  get: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: {
    inbox: {
      list: apiMocks.list,
      markReadBatch: apiMocks.markReadBatch,
      markRead: apiMocks.markRead,
      remove: apiMocks.remove,
      restore: apiMocks.restore,
      purge: apiMocks.purge,
      archive: apiMocks.archive,
      get: apiMocks.get,
      unreadCount: vi.fn(async () => ({ ok: true, unreadCount: 0 })),
      assetUrl: vi.fn(),
      fetchAsset: vi.fn(),
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'inbox.title': 'Inbox',
        'inbox.empty': 'No messages',
        'inbox.unreadDot': 'Unread',
        'inbox.markAllRead': 'Mark all read',
        'inbox.markRead': 'Mark read',
        'inbox.markUnread': 'Mark unread',
        'inbox.delete': 'Delete',
        'inbox.loadMore': 'Load more',
        'inbox.jump': 'Jump',
        'inbox.noPreview': 'Pick a message',
        'common.close': 'Close',
        'common.back': 'Back',
        'common.cancel': 'Cancel',
        'common.loading': 'Loading',
        'inbox.archiveRead': 'Archive read',
        'inbox.archiveReadHint': 'Archive all read',
        'inbox.noReadToArchive': 'Nothing to archive',
        'inbox.confirmArchiveRead': 'Archive {n} read messages?',
        'inbox.archiveSelected': 'Archive',
        'inbox.archiveSelectedHint': 'Archive selected read',
        'inbox.viewActive': 'Active view',
        'inbox.viewArchived': 'Archived view',
        'inbox.viewTrash': 'Trash view',
        'inbox.statusAll': 'All status',
        'inbox.statusUnread': 'Unread status',
        'inbox.statusRead': 'Read status',
        'inbox.sourceAll': 'All sources',
        'inbox.rangeAll': 'All time',
        'inbox.range1d': 'Last 24h',
        'inbox.range7d': 'Last 7 days',
        'inbox.range30d': 'Last 30 days',
        'inbox.selectAll': 'Select all',
        'inbox.selectAllScope': 'Select all filtered results',
        'inbox.restore': 'Restore',
        'inbox.restoreSelected': 'Restore selected',
        'inbox.purge': 'Delete permanently',
        'inbox.purgeSelected': 'Delete permanently',
        'inbox.confirmTrash': 'Move to Trash? Restorable for 7 days.',
        'inbox.confirmTrashMany': 'Move {n} messages to Trash? Restorable for 7 days.',
        'inbox.confirmPurge': 'Permanently delete this message?',
        'inbox.confirmPurgeMany': 'Permanently delete {n} messages?',
        'inbox.closeAllTabs': 'Close all tabs',
        'inbox.closeAllTabsHint': 'Close all open preview tabs',
        'inbox.noOpenTabs': 'No open tabs',
        'inbox.confirmCloseAllTabs': 'Close {n} open tabs? Messages stay.',
        'inbox.capacityHint': 'Capacity',
        'inbox.syncSynced': 'Synced',
        'inbox.syncSyncing': 'Syncing…',
        'inbox.syncPending': 'Pending sync',
        'inbox.syncReconnecting': 'Reconnecting…',
        'inbox.syncError': 'Sync failed',
      }
      let text = map[key] || key
      for (const [k, v] of Object.entries(params || {})) text = text.replace(`{${k}}`, String(v))
      return text
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
    filter: { query: '', type: 'all', status: 'all', view: 'active', source: '', range: 'all' },
    lastRev: 0,
    deletedRev: {},
    stats: null,
    pendingSync: 0,
    syncError: false,
  })
  useConsoleStore.setState({
    connection: { status: 'connected', latency: 0, lastPing: new Date().toISOString() },
  })
}
// view 走 store.setFilter：Select 交互由组件自身测试覆盖，这里只测面板语义
function setView(view: InboxViewFilter) {
  act(() => {
    useInboxStore.getState().setFilter({ view })
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
    apiMocks.restore.mockResolvedValue({ ok: true, restored: 1 })
    apiMocks.purge.mockResolvedValue({ ok: true, purged: 1 })
    apiMocks.archive.mockResolvedValue({ ok: true, changed: 1, skippedUnread: 0 })
    resetInboxStore()
  })

  it('lists messages with unread dot and opens preview + marks read on click (mobile)', async () => {
    const onPreview = vi.fn()
    useInboxStore.setState({
      messages: [message({ id: 'm1' }), message({ id: 'm2', title: 'read one', readBy: ['dev-1'], readAt: 'x' })],
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
    await waitFor(() => expect(apiMocks.markReadBatch).toHaveBeenCalledWith(['m1'], 'dev-1', true))
    await waitFor(() =>
      expect(useInboxStore.getState().messages.find((item) => item.id === 'm1')?.readBy).toContain('dev-1'),
    )
  })

  it('does not re-mark a message already read on this device', () => {
    useInboxStore.setState({ messages: [message({ id: 'm1', readBy: ['dev-1'], readAt: 'x' })] })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} onPreview={vi.fn()} />)
    fireEvent.click(screen.getByText('hello world'))
    expect(apiMocks.markReadBatch).not.toHaveBeenCalled()
    expect(apiMocks.markRead).not.toHaveBeenCalled()
  })

  it('moves a message to trash via REST after explicit confirmation', async () => {
    useInboxStore.setState({ messages: [message({ id: 'm1' })], unreadCount: 1 })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    // 已读≠删除：点垃圾桶只打开确认框，REST 尚未触发
    expect(apiMocks.remove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Delete' })
    expect(dialog.textContent).toContain('Restorable')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith(['m1']))
    // 软删：消息留在镜像（deletedAt），活动视图不再显示，角标清零
    const stored = useInboxStore.getState().messages.find((item) => item.id === 'm1')
    expect(stored?.deletedAt).toBeTruthy()
    expect(useInboxStore.getState().unreadCount).toBe(0)
    expect(screen.queryByText('hello world')).toBeNull()
  })

  it('restores a trashed message and purges it permanently', async () => {
    useInboxStore.setState({
      messages: [
        message({ id: 't1', title: 'trashed', deletedAt: '2026-09-26T09:00:00.000Z' }),
        message({ id: 'a1', title: 'active' }),
      ],
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    setView('trash')
    expect(screen.getByText('trashed')).toBeTruthy()
    expect(screen.queryByText('active')).toBeNull()
    // 恢复：回活动视图
    const row = screen.getByText('trashed').closest('div')!
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(apiMocks.restore).toHaveBeenCalledWith(['t1']))
    expect(useInboxStore.getState().messages.find((m) => m.id === 't1')?.deletedAt).toBeUndefined()
    // 再进回收站后 purge：确认框明说不可恢复，确认后物理移除
    act(() => useInboxStore.getState().trashLocal(['t1'], true))
    const trashRow = screen.getByText('trashed').closest('div')!
    fireEvent.click(within(trashRow).getByRole('button', { name: 'Delete permanently' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete permanently' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(apiMocks.purge).toHaveBeenCalledWith(['t1']))
    expect(useInboxStore.getState().messages.find((m) => m.id === 't1')).toBeUndefined()
  })

  it('keeps a message in history after it is marked read', async () => {
    useInboxStore.setState({ messages: [message({ id: 'm1' })], unreadCount: 1 })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} onPreview={vi.fn()} />)
    await act(async () => {})
    fireEvent.click(screen.getByText('hello world'))
    await waitFor(() => expect(apiMocks.markReadBatch).toHaveBeenCalledWith(['m1'], 'dev-1', true))
    // 已读只清蓝点/计数：行与历史仍在
    expect(screen.getByText('hello world')).toBeTruthy()
    const stored = useInboxStore.getState().messages.find((item) => item.id === 'm1')
    expect(stored?.readAt).toBeTruthy()
    expect(useInboxStore.getState().unreadCount).toBe(0)
    // 刷新（列表回源同一份数据）后已读消息仍在
    await act(async () => {
      const { refreshInboxList } = await import('@/hooks/useInbox')
      await refreshInboxList()
    })
    expect(screen.getByText('hello world')).toBeTruthy()
  })

  it('marks a read message back to unread from the row action', async () => {
    useInboxStore.setState({
      messages: [message({ id: 'm1', readAt: '2026-09-26T09:00:00.000Z', readBy: ['dev-1'] })],
      unreadCount: 0,
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    const row = screen.getByText('hello world').closest('div')!.parentElement!
    fireEvent.click(within(row).getByRole('button', { name: 'Mark unread' }))
    await waitFor(() => expect(apiMocks.markReadBatch).toHaveBeenCalledWith(['m1'], 'dev-1', false))
    const stored = useInboxStore.getState().messages.find((item) => item.id === 'm1')
    expect(stored?.readAt).toBeUndefined()
    expect(useInboxStore.getState().unreadCount).toBe(1)
  })

  it('batch-selects messages and trashes them with confirmation', async () => {
    useInboxStore.setState({
      // 列表按 createdAt desc + id desc 排序：给递减时间戳让 DOM 顺序 = m1,m2,m3
      messages: [
        message({ id: 'm1', createdAt: '2026-09-26T10:00:03.000Z' }),
        message({ id: 'm2', title: 'second', createdAt: '2026-09-26T10:00:02.000Z' }),
        message({ id: 'm3', title: 'third', createdAt: '2026-09-26T10:00:01.000Z' }),
      ],
      unreadCount: 3,
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    const boxes = screen.getAllByRole('checkbox')
    // [全选, m1, m2, m3]
    fireEvent.click(boxes[1])
    fireEvent.click(boxes[2])
    const deleteSelected = await screen.findByRole('button', { name: 'inbox.deleteSelected' })
    fireEvent.click(deleteSelected)
    const dialog = await screen.findByRole('dialog', { name: 'Delete' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith(['m1', 'm2']))
    // 软删后镜像仍含两条（deletedAt），活动视图只剩 m3
    expect(useInboxStore.getState().messages).toHaveLength(3)
    expect(screen.queryByText('hello world')).toBeNull()
    expect(screen.getByText('third')).toBeTruthy()
  })

  it('select-all checkbox scopes to current filtered results', async () => {
    useInboxStore.setState({
      messages: [
        message({ id: 'm1', title: 'alpha report' }),
        message({ id: 'm2', title: 'beta report' }),
        message({ id: 'm3', title: 'alpha log', type: 'file' }),
      ],
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    // 类型筛 file 后全选只圈到筛选结果（m3），不是全历史
    act(() => {
      useInboxStore.getState().setFilter({ type: 'file' })
    })
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' })
    expect(selectAll.title).toContain('filtered')
    fireEvent.click(selectAll)
    // 批量条报 1 项；删除只作用于 m3
    fireEvent.click(await screen.findByRole('button', { name: 'inbox.deleteSelected' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith(['m3']))
  })

  it('archives read messages with confirmation; unread untouched; restorable', async () => {
    const readAt = '2026-09-26T09:00:00.000Z'
    useInboxStore.setState({
      messages: [
        message({ id: 'u1', title: 'unread one', createdAt: '2026-09-26T10:00:03.000Z' }),
        message({ id: 'r1', title: 'read one', readAt, createdAt: '2026-09-26T10:00:02.000Z' }),
        message({ id: 'r2', title: 'read two', readAt, createdAt: '2026-09-26T10:00:01.000Z' }),
      ],
      unreadCount: 1,
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    // 确认前 REST 未触发，确认框报条数
    fireEvent.click(screen.getByRole('button', { name: 'Archive read' }))
    expect(apiMocks.archive).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Archive read' })
    expect(dialog.textContent).toContain('2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive read' }))
    await waitFor(() => expect(apiMocks.archive).toHaveBeenCalled())
    const [idsArg, archivedArg] = apiMocks.archive.mock.calls[0]
    expect([...idsArg].sort()).toEqual(['r1', 'r2'])
    expect(archivedArg).toBe(true)
    // 活动视图：已读的离开列表但未删（仍在镜像里），未读不受影响
    const state = useInboxStore.getState()
    expect(state.messages).toHaveLength(3)
    expect(state.messages.find((m) => m.id === 'r1')?.archivedAt).toBeTruthy()
    expect(screen.queryByText('read one')).toBeNull()
    expect(screen.getByText('unread one')).toBeTruthy()
    // 归档视图可见历史并可恢复
    setView('archived')
    expect(screen.getByText('read one')).toBeTruthy()
    expect(screen.queryByText('unread one')).toBeNull()
    const row = screen.getByText('read one').closest('div')!
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(apiMocks.archive).toHaveBeenLastCalledWith(['r1'], false))
    expect(useInboxStore.getState().messages.find((m) => m.id === 'r1')?.archivedAt).toBeUndefined()
    // 刷新（回源同一镜像含归档）后活动视图仍只显示活动的
    setView('active')
    await act(async () => {
      const { refreshInboxList } = await import('@/hooks/useInbox')
      await refreshInboxList()
    })
    expect(screen.getByText('read one')).toBeTruthy()
    expect(screen.getByText('unread one')).toBeTruthy()
    expect(screen.queryByText('read two')).toBeNull()
  })

  it('disables Archive read when no read messages exist', () => {
    useInboxStore.setState({ messages: [message({ id: 'u1' })], unreadCount: 1 })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Archive read' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('marks every unread message read from the header action', async () => {
    useInboxStore.setState({
      messages: [message({ id: 'a' }), message({ id: 'b', readBy: ['dev-1'], readAt: 'x' }), message({ id: 'c' })],
      unreadCount: 2,
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => expect(apiMocks.markReadBatch).toHaveBeenCalled())
    const [idsArg, deviceArg, readArg] = apiMocks.markReadBatch.mock.calls[0]
    expect([...idsArg].sort()).toEqual(['a', 'c'])
    expect(deviceArg).toBe('dev-1')
    expect(readArg).toBe(true)
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

  it('closes all open tabs locally — messages, read state and server untouched', async () => {
    useInboxStore.setState({
      messages: [
        message({ id: 'm1', createdAt: '2026-09-26T10:00:03.000Z' }),
        message({ id: 'm2', title: 'second', createdAt: '2026-09-26T10:00:02.000Z' }),
      ],
    })
    render(<InboxPanel mode="desktop" onClose={vi.fn()} />)
    await act(async () => {})
    fireEvent.click(screen.getByText('hello world'))
    fireEvent.click(screen.getByText('second'))
    await waitFor(() => expect(useInboxStore.getState().tabs).toHaveLength(2))
    // 关闭全部：先确认，报 tab 数；此时无 REST 触发
    const closeAll = screen.getByRole('button', { name: 'Close all tabs' })
    expect(closeAll.textContent).toContain('2')
    fireEvent.click(closeAll)
    const dialog = await screen.findByRole('dialog', { name: 'Close all tabs' })
    expect(dialog.textContent).toContain('2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close all tabs' }))
    // 右侧为空态；tab 集合清空；消息/已读原样，服务端零调用
    expect(useInboxStore.getState().tabs).toEqual([])
    expect(useInboxStore.getState().activeTabId).toBeNull()
    expect(screen.getByText('Pick a message')).toBeTruthy()
    expect(apiMocks.archive).not.toHaveBeenCalled()
    expect(apiMocks.remove).not.toHaveBeenCalled()
    expect(useInboxStore.getState().messages).toHaveLength(2)
    // 重新打开同一条消息行为不破坏
    fireEvent.click(screen.getByText('hello world'))
    await waitFor(() => expect(screen.getByText('preview:m1')).toBeTruthy())
    expect(useInboxStore.getState().tabs).toHaveLength(1)
  })

  it('disables Close all tabs when no preview tabs are open', () => {
    useInboxStore.setState({ messages: [message({ id: 'm1' })] })
    render(<InboxPanel mode="desktop" onClose={vi.fn()} />)
    const closeAll = screen.getByRole('button', { name: 'Close all tabs' }) as HTMLButtonElement
    expect(closeAll.disabled).toBe(true)
    expect(closeAll.title).toBe('No open tabs')
  })

  it('filters by read status, query body and source', async () => {
    useInboxStore.setState({
      messages: [
        message({ id: 'a', title: 'alpha', text: 'deployment failed', source: { agent: 'codex' } }),
        message({
          id: 'b',
          title: 'beta',
          text: 'deployment failed',
          readAt: 'x',
          source: { agent: 'devin' },
        }),
        message({ id: 'c', title: 'gamma', text: 'all good', source: { agent: 'codex' } }),
      ],
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    // 状态筛：未读 → a,c
    act(() => useInboxStore.getState().setFilter({ status: 'unread' }))
    expect(screen.queryByText('beta')).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
    // 正文搜索叠加：只剩 a
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'deployment' } })
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('gamma')).toBeNull()
    // 来源筛 devin：未读+devin 无结果
    act(() => useInboxStore.getState().setFilter({ source: 'devin', query: '' }))
    expect(screen.getByText('inbox.noMatch')).toBeTruthy()
    // 已读+devin → b
    act(() => useInboxStore.getState().setFilter({ status: 'read' }))
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('filters by time range', async () => {
    const recent = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
    useInboxStore.setState({
      messages: [
        message({ id: 'new', title: 'fresh', createdAt: recent }),
        message({ id: 'old', title: 'stale', createdAt: old }),
      ],
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    act(() => useInboxStore.getState().setFilter({ range: '1d' }))
    expect(screen.getByText('fresh')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
    act(() => useInboxStore.getState().setFilter({ range: '30d' }))
    expect(screen.getByText('stale')).toBeTruthy()
  })

  it('shows capacity stats and sync status', async () => {
    useInboxStore.setState({
      messages: [message({ id: 'm1' })],
      stats: { messages: 34, maxMessages: 1000, assetBytes: 12.5 * 1024 * 1024, maxAssetBytes: 512 * 1024 * 1024 },
    })
    render(<InboxPanel mode="mobile" onClose={vi.fn()} />)
    await act(async () => {})
    expect(screen.getByText(/34\/1000/)).toBeTruthy()
    expect(screen.getByText('Synced')).toBeTruthy()
    // 在途同步 → syncing；断线 → reconnecting；失败 → error
    act(() => useInboxStore.setState({ pendingSync: 1 }))
    expect(screen.getByText('Syncing…')).toBeTruthy()
    act(() => {
      useInboxStore.setState({ pendingSync: 0 })
      useConsoleStore.setState({
        connection: { status: 'reconnecting', latency: 0, lastPing: '' },
      })
    })
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
    act(() => useInboxStore.setState({ syncError: true }))
    expect(screen.getByText('Sync failed')).toBeTruthy()
  })
})
