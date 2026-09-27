import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useInboxStore, inboxMessageTitle, isInboxArchivable } from './useInboxStore'
import type { AgentInboxMessage } from '@/types'

const apiMocks = vi.hoisted(() => ({
  inboxGet: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: {
    inbox: {
      get: apiMocks.inboxGet,
      list: vi.fn(),
      unreadCount: vi.fn(),
      markRead: vi.fn(),
      markReadBatch: vi.fn(),
      remove: vi.fn(),
      assetUrl: vi.fn(),
      fetchAsset: vi.fn(),
    },
  },
}))

function message(partial: Partial<AgentInboxMessage>): AgentInboxMessage {
  return {
    id: 'm1',
    type: 'text',
    title: 'hello',
    source: {},
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
    listLoaded: false,
    tabs: [],
    activeTabId: null,
    panelOpen: false,
    filter: { query: '', type: 'all', status: 'all', view: 'active', source: '', range: 'all' },
    lastRev: 0,
    deletedRev: {},
    stats: null,
    pendingSync: 0,
    syncError: false,
  })
}

describe('useInboxStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    apiMocks.inboxGet.mockReset()
    resetInboxStore()
  })

  it('setList sorts newest first and drops expired messages', () => {
    const store = useInboxStore.getState()
    store.setList(
      [
        message({ id: 'old', createdAt: '2026-09-20T10:00:00.000Z' }),
        message({ id: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
        message({ id: 'new', createdAt: '2026-09-26T10:00:00.000Z' }),
      ],
      'cursor-1',
    )
    const state = useInboxStore.getState()
    expect(state.messages.map((item) => item.id)).toEqual(['new', 'old'])
    expect(state.nextCursor).toBe('cursor-1')
    expect(state.listLoaded).toBe(true)
  })

  it('appendList merges without duplicates and keeps sort order', () => {
    const store = useInboxStore.getState()
    store.setList([message({ id: 'b', createdAt: '2026-09-25T10:00:00.000Z' })], 'c1')
    store.appendList(
      [
        message({ id: 'b', createdAt: '2026-09-25T10:00:00.000Z' }),
        message({ id: 'a', createdAt: '2026-09-24T10:00:00.000Z' }),
      ],
      'c2',
    )
    const state = useInboxStore.getState()
    expect(state.messages.map((item) => item.id)).toEqual(['b', 'a'])
    expect(state.nextCursor).toBe('c2')
  })

  it('upsertMessage updates tabs metadata when the message changes', () => {
    const store = useInboxStore.getState()
    const original = message({ id: 'm1', title: 'first' })
    store.openTab(original)
    store.upsertMessage(message({ id: 'm1', title: 'renamed', type: 'file' }))
    const tab = useInboxStore.getState().tabs.find((item) => item.id === 'm1')
    expect(tab?.title).toBe('renamed')
    expect(tab?.type).toBe('file')
  })

  it('markReadLocal only counts messages unread for this device', () => {
    const store = useInboxStore.getState()
    store.setList(
      [message({ id: 'a', readBy: [] }), message({ id: 'b', readBy: ['dev-1'] }), message({ id: 'c', readBy: [] })],
      null,
    )
    store.setUnreadCount(2)
    const changed = store.markReadLocal(['a', 'b', 'missing'])
    expect(changed).toBe(1)
    const state = useInboxStore.getState()
    expect(state.unreadCount).toBe(1)
    expect(state.messages.find((item) => item.id === 'a')?.readBy).toContain('dev-1')
  })

  it('removeMessages drops messages, tabs and unread count together', () => {
    const store = useInboxStore.getState()
    const target = message({ id: 'a', readBy: [] })
    store.setList([target, message({ id: 'b', readBy: ['dev-1'] })], null)
    store.setUnreadCount(1)
    store.openTab(target)
    store.removeMessages(['a'])
    const state = useInboxStore.getState()
    expect(state.messages.map((item) => item.id)).toEqual(['b'])
    expect(state.tabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
    expect(state.unreadCount).toBe(0)
  })

  it('openTab reactivates existing tab and evicts oldest unpinned beyond the cap', () => {
    const store = useInboxStore.getState()
    for (let index = 0; index < 20; index += 1) {
      store.openTab(
        message({
          id: `m${index}`,
          createdAt: `2026-09-2${index % 10}T10:00:00.000Z`,
          title: `t${index}`,
        }),
      )
      // 打开时间递增保证淘汰顺序确定
      useInboxStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === `m${index}`
            ? { ...tab, lastOpenedAt: `2026-09-26T10:${String(index).padStart(2, '0')}:00.000Z` }
            : tab,
        ),
      }))
    }
    useInboxStore.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === 'm0' ? { ...tab, pinned: true } : tab)),
    }))
    store.openTab(message({ id: 'new', title: 'newest' }))
    const ids = useInboxStore.getState().tabs.map((tab) => tab.id)
    expect(ids).toHaveLength(20)
    expect(ids).toContain('m0') // pinned 不淘汰
    expect(ids).toContain('new')
    expect(ids).not.toContain('m1') // 最久未开且未 pin 的被踢出
  })

  it('hydrateTabs drops gone messages and refreshes metadata', async () => {
    const store = useInboxStore.getState()
    store.openTab(message({ id: 'live', title: 'old title' }))
    useInboxStore.setState((state) => ({
      tabs: [
        ...state.tabs,
        { id: 'gone', messageId: 'gone', title: 'gone', type: 'text', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
      ],
      activeTabId: 'gone',
    }))
    apiMocks.inboxGet.mockImplementation(async (id: string) => {
      if (id === 'live') return { ok: true, message: message({ id: 'live', title: 'fresh title' }) }
      throw new Error('404')
    })
    await useInboxStore.getState().hydrateTabs()
    const state = useInboxStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual(['live'])
    expect(state.tabs[0].title).toBe('fresh title')
    expect(state.activeTabId).toBeNull()
  })

  it('inboxMessageTitle prefers title then name then first text line', () => {
    expect(inboxMessageTitle(message({ title: ' T ' }))).toBe('T')
    expect(inboxMessageTitle(message({ title: '', name: 'report.png' }))).toBe('report.png')
    expect(inboxMessageTitle(message({ title: '', name: '', text: '\n\nfirst line\nsecond' }))).toBe('first line')
  })

  it('setList adopts server revision and clears tombstones', () => {
    const store = useInboxStore.getState()
    store.applyInboxDeleted(['ghost'], 9)
    store.setList([message({ id: 'a', rev: 3 })], null, 5)
    const state = useInboxStore.getState()
    expect(state.lastRev).toBe(9) // rev 只升不降
    expect(state.deletedRev).toEqual({}) // 快照即事实，墓碑清空
  })

  it('gates events by revision: stale drops, gap signals resync', () => {
    const store = useInboxStore.getState()
    store.setList([message({ id: 'a', rev: 5 })], null, 5)
    // 旧事件：不覆盖新状态
    expect(store.applyInboxUpdated([message({ id: 'a', title: 'stale' })], 4)).toBe('stale')
    // 跳号：丢事件 → 调用方回源
    expect(store.applyInboxCreated(message({ id: 'b' }), 9)).toBe('gap')
    // 顺序事件正常应用
    expect(store.applyInboxCreated(message({ id: 'b' }), 6)).toBe('applied')
    // 重复事件幂等
    expect(store.applyInboxCreated(message({ id: 'b' }), 6)).toBe('stale')
    const state = useInboxStore.getState()
    expect(state.lastRev).toBe(6)
    expect(state.messages.find((item) => item.id === 'a')?.title).toBe('hello')
  })

  it('keeps tombstones so late updates cannot resurrect deleted messages', () => {
    const store = useInboxStore.getState()
    store.setList([message({ id: 'a' })], null, 3)
    expect(store.applyInboxDeleted(['a'], 4)).toBe('applied')
    expect(useInboxStore.getState().messages).toHaveLength(0)
    // 迟到 update：id 在墓碑里被过滤，不复活
    expect(store.applyInboxUpdated([message({ id: 'a', title: 'zombie' })], 5)).toBe('applied')
    expect(useInboxStore.getState().messages).toHaveLength(0)
    // 同 id 重新 push（rev 高于墓碑）可以进来
    expect(store.applyInboxCreated(message({ id: 'a' }), 6)).toBe('applied')
    expect(useInboxStore.getState().messages).toHaveLength(1)
  })

  it('markReadLocal writes global readAt and skips already-read messages', () => {
    const store = useInboxStore.getState()
    store.setList(
      [message({ id: 'a' }), message({ id: 'b', readAt: '2026-09-26T09:00:00.000Z' }), message({ id: 'c' })],
      null,
    )
    store.setUnreadCount(2)
    expect(store.markReadLocal(['a', 'b', 'c'])).toBe(2)
    const state = useInboxStore.getState()
    expect(state.messages.find((item) => item.id === 'a')?.readAt).toBeTruthy()
    expect(state.messages.find((item) => item.id === 'c')?.readBy).toContain('dev-1')
    expect(state.unreadCount).toBe(0)
    // 全局已读后其他设备视角也为已读：再次 mark 幂等
    expect(store.markReadLocal(['a'])).toBe(0)
  })

  it('archiveLocal only closes read messages and unarchives idempotently', () => {
    const store = useInboxStore.getState()
    store.setList(
      [
        message({ id: 'unread' }),
        message({ id: 'read', readAt: '2026-09-26T09:00:00.000Z' }),
        message({ id: 'arch', readAt: '2026-09-26T08:00:00.000Z', archivedAt: '2026-09-26T09:00:00.000Z' }),
      ],
      null,
    )
    // 未读不归档（镜像服务端 guard）；已归档的再归档幂等
    expect(store.archiveLocal(['unread', 'read', 'arch'], true)).toBe(1)
    const state = useInboxStore.getState()
    expect(state.messages.find((m) => m.id === 'unread')?.archivedAt).toBeUndefined()
    expect(state.messages.find((m) => m.id === 'read')?.archivedAt).toBeTruthy()
    // 恢复：只影响带 archivedAt 的，且幂等
    expect(store.archiveLocal(['read', 'unread'], false)).toBe(1)
    expect(useInboxStore.getState().messages.find((m) => m.id === 'read')?.archivedAt).toBeUndefined()
    expect(store.archiveLocal(['read'], false)).toBe(0)
  })

  it('isInboxArchivable covers read-active messages only', () => {
    expect(isInboxArchivable(message({ readAt: 'x' }), 'dev-1')).toBe(true)
    expect(isInboxArchivable(message({}), 'dev-1')).toBe(false) // 未读不可归档
    expect(isInboxArchivable(message({ readAt: 'x', archivedAt: 'y' }), 'dev-1')).toBe(false) // 已归档
    expect(isInboxArchivable(message({ readAt: 'x', deletedAt: 'y' }), 'dev-1')).toBe(false) // 回收站
    expect(isInboxArchivable(message({ readBy: ['dev-1'] }), 'dev-1')).toBe(true) // 旧 readBy 兼容
  })

  it('markUnreadLocal clears readAt and restores the unread badge', () => {
    const store = useInboxStore.getState()
    store.setList(
      [
        message({ id: 'read', readAt: '2026-09-26T09:00:00.000Z', readBy: ['dev-1'] }),
        message({ id: 'unread' }),
        message({ id: 'trashed', readAt: 'x', deletedAt: 'y' }),
      ],
      null,
    )
    store.setUnreadCount(1)
    expect(store.markUnreadLocal(['read', 'unread', 'trashed'])).toBe(1)
    const state = useInboxStore.getState()
    const read = state.messages.find((m) => m.id === 'read')
    expect(read?.readAt).toBeUndefined()
    expect(read?.readBy).toEqual([])
    // 回收站消息不计角标——标未读不动它
    expect(state.messages.find((m) => m.id === 'trashed')?.readAt).toBe('x')
    expect(state.unreadCount).toBe(2)
  })

  it('trashLocal soft-deletes with badge adjust and restores symmetrically', () => {
    const store = useInboxStore.getState()
    store.setList([message({ id: 'unread' }), message({ id: 'read', readAt: 'x' })], null)
    store.setUnreadCount(1)
    // 未读进回收站扣角标；已读不动
    expect(store.trashLocal(['unread', 'read'], true)).toBe(2)
    let state = useInboxStore.getState()
    expect(state.unreadCount).toBe(0)
    expect(state.messages.every((m) => m.deletedAt)).toBe(true)
    // 幂等：再删一遍 changed=0
    expect(store.trashLocal(['unread'], true)).toBe(0)
    // 恢复未读回补角标
    expect(store.trashLocal(['unread', 'read'], false)).toBe(2)
    state = useInboxStore.getState()
    expect(state.unreadCount).toBe(1)
    expect(state.messages.every((m) => !m.deletedAt)).toBe(true)
  })

  it('closeAllTabs clears tabs without touching messages or read state', () => {
    const store = useInboxStore.getState()
    const read = message({ id: 'm1', readAt: 'x' })
    store.setList([read, message({ id: 'm2' })], null)
    store.openTab(read)
    store.openTab(useInboxStore.getState().messages.find((m) => m.id === 'm2')!)
    expect(useInboxStore.getState().tabs).toHaveLength(2)
    store.closeAllTabs()
    const state = useInboxStore.getState()
    expect(state.tabs).toEqual([])
    expect(state.activeTabId).toBeNull()
    // 消息原样：不归档不删除不改已读
    expect(state.messages).toHaveLength(2)
    expect(state.messages.find((m) => m.id === 'm1')?.readAt).toBe('x')
    expect(state.messages.every((m) => !m.archivedAt && !m.deletedAt)).toBe(true)
  })

  it('beginSync/endSync track pending mutations and error state', () => {
    const store = useInboxStore.getState()
    store.beginSync()
    store.beginSync()
    expect(useInboxStore.getState().pendingSync).toBe(2)
    store.endSync()
    expect(useInboxStore.getState().pendingSync).toBe(1)
    expect(useInboxStore.getState().syncError).toBe(false)
    store.endSync(true)
    const state = useInboxStore.getState()
    expect(state.pendingSync).toBe(0)
    expect(state.syncError).toBe(true)
    // 下一次成功同步清掉错误标记
    store.beginSync()
    store.endSync()
    expect(useInboxStore.getState().syncError).toBe(false)
  })

  it('markReadLocal skips trashed messages (badge must not drop twice)', () => {
    const store = useInboxStore.getState()
    store.setList([message({ id: 'a', deletedAt: 'x' })], null)
    store.setUnreadCount(0)
    expect(store.markReadLocal(['a'])).toBe(0)
    expect(useInboxStore.getState().unreadCount).toBe(0)
    expect(useInboxStore.getState().messages[0].readAt).toBeUndefined()
  })
})
