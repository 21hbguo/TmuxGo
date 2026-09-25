import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useInboxStore, inboxMessageTitle } from './useInboxStore'
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
})
