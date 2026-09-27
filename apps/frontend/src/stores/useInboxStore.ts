import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '@/lib/persist-storage'
import { detectDeviceKind } from '@/lib/console-device-state'
import { api } from '@/lib/api'
import type { AgentInboxMessage, InboxFilter, InboxTab } from '@/types'

const INBOX_STORAGE_KEY = `tmuxgo-inbox-state:${detectDeviceKind()}`
const MAX_TABS = 20
const MAX_MESSAGES = 500
// 删除墓碑上限：防迟到 update 复活已删消息；条数有界，旧墓碑先丢
const MAX_DELETED_REV = 1000

function isExpiredMessage(message: AgentInboxMessage, now = Date.now()) {
  return !!message.expiresAt && Date.parse(message.expiresAt) < now
}
// 全局已读语义：服务端 readAt 为准；readBy 兼容旧数据（设备明细）
export function isInboxUnread(message: AgentInboxMessage, deviceId: string) {
  return !message.readAt && !message.readBy.includes(deviceId)
}
// 关闭已打开=归档：不删 nada，历史可查。未读消息服务端拒绝归档
export function isInboxArchived(message: AgentInboxMessage) {
  return !!message.archivedAt
}
// 回收站=软删可恢复：不是真删除，purge/TTL 才回收
export function isInboxTrashed(message: AgentInboxMessage) {
  return !!message.deletedAt
}
// 可归档集合 = 活动列表里已读的（不归档不进回收站）。
// 注意：「已打开」仅指右侧预览 tab，与消息状态无关——别再用 opened 命名消息态
export function isInboxArchivable(message: AgentInboxMessage, deviceId: string) {
  return !isInboxArchived(message) && !isInboxTrashed(message) && !isInboxUnread(message, deviceId)
}
// 列表镜像统一按 createdAt 倒序（新→旧），id 做同刻稳定 tiebreak
function sortMessagesDesc(list: AgentInboxMessage[]) {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}
// rev 门控：无 rev（旧服务端）放行；rev<=lastRev 重复/乱序丢弃；
// rev 跳号说明中间丢了事件 → 返回 gap 由调用方回源快照
function revGate(lastRev: number, rev?: number): 'apply' | 'stale' | 'gap' {
  if (typeof rev !== 'number' || !Number.isFinite(rev)) return 'apply'
  if (rev <= lastRev) return 'stale'
  if (lastRev > 0 && rev > lastRev + 1) return 'gap'
  return 'apply'
}
function nextRev(lastRev: number, rev?: number) {
  return typeof rev === 'number' && Number.isFinite(rev) ? Math.max(lastRev, rev) : lastRev
}
function maxMessageRev(messages: AgentInboxMessage[]) {
  return messages.reduce((max, m) => Math.max(max, m.rev || 0), 0)
}
export function inboxMessageTitle(message: AgentInboxMessage) {
  if (message.title?.trim()) return message.title.trim()
  if (message.name?.trim()) return message.name.trim()
  const firstLine = (message.text || '').split('\n').find((line) => line.trim())
  return (firstLine || message.text || '').trim().slice(0, 80)
}
function tabFromMessage(message: AgentInboxMessage, previous?: InboxTab): InboxTab {
  return {
    id: message.id,
    messageId: message.id,
    hostId: message.route?.hostId,
    sessionName: message.route?.sessionName,
    paneId: message.route?.paneId || message.route?.tmuxPaneId,
    title: inboxMessageTitle(message) || previous?.title || message.id,
    type: message.type,
    pinned: previous?.pinned,
    lastOpenedAt: new Date().toISOString(),
  }
}
function isValidTab(value: unknown): value is InboxTab {
  const tab = value as InboxTab
  return (
    !!tab &&
    typeof tab.id === 'string' &&
    typeof tab.messageId === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.lastOpenedAt === 'string' &&
    ['text', 'image', 'video', 'file', 'link'].includes(String(tab.type))
  )
}

interface InboxState {
  deviceId: string
  messages: AgentInboxMessage[]
  unreadCount: number
  nextCursor: string | null
  listLoaded: boolean
  tabs: InboxTab[]
  activeTabId: string | null
  panelOpen: boolean
  // 列表筛选（内存态，不持久化）：面板重开/切预览 tab 时都保留
  filter: InboxFilter
  // 预览滚动位置按 messageId 记忆：切 tab 回来不丢阅读进度
  previewScroll: Record<string, number>
  // 服务端 revision 基线：rest 快照设置，WS 事件按它丢旧/检测 gap
  lastRev: number
  // 删除墓碑：迟到的 update 不许复活已删消息（rev 记录删除时的版本）
  deletedRev: Record<string, number>
  // 容量提示：来自列表响应的服务端权威口径（含回收站 asset 占用）
  stats: { messages: number; maxMessages: number; assetBytes: number; maxAssetBytes: number } | null
  // 同步提示：在途乐观写/对账数 + 最近一次失败标记
  pendingSync: number
  syncError: boolean
  setDeviceId: (deviceId: string) => void
  setFilter: (patch: Partial<InboxFilter>) => void
  setPreviewScroll: (messageId: string, top: number) => void
  setList: (messages: AgentInboxMessage[], nextCursor: string | null, revision?: number) => void
  appendList: (messages: AgentInboxMessage[], nextCursor: string | null, revision?: number) => void
  // WS 事件入口：返回 applied/stale/gap 让调用方决定是否回源快照
  applyInboxCreated: (message: AgentInboxMessage, rev?: number) => 'applied' | 'stale' | 'gap'
  applyInboxUpdated: (messages: AgentInboxMessage[], rev?: number) => 'applied' | 'stale' | 'gap'
  applyInboxDeleted: (ids: string[], rev?: number) => 'applied' | 'stale' | 'gap'
  upsertMessage: (message: AgentInboxMessage) => void
  removeMessages: (ids: string[]) => void
  setUnreadCount: (count: number) => void
  markReadLocal: (ids: string[]) => number
  markUnreadLocal: (ids: string[]) => number
  archiveLocal: (ids: string[], archived: boolean) => number
  trashLocal: (ids: string[], deleted: boolean) => number
  setStats: (stats: InboxState['stats']) => void
  beginSync: () => void
  endSync: (error?: boolean) => void
  closeAllTabs: () => void
  setPanelOpen: (open: boolean) => void
  openTab: (message: AgentInboxMessage) => void
  openTabById: (messageId: string) => Promise<AgentInboxMessage | null>
  closeTab: (id: string) => void
  setActiveTab: (id: string | null) => void
  togglePinTab: (id: string) => void
  hydrateTabs: () => Promise<void>
}

export const useInboxStore = create<InboxState>()(
  persist(
    (set, get) => ({
      deviceId: '',
      messages: [],
      unreadCount: 0,
      nextCursor: null,
      listLoaded: false,
      tabs: [],
      activeTabId: null,
      panelOpen: false,
      filter: { query: '', type: 'all', status: 'all', view: 'active', source: '', range: 'all' },
      previewScroll: {},
      lastRev: 0,
      deletedRev: {},
      stats: null,
      pendingSync: 0,
      syncError: false,
      setDeviceId: (deviceId) => set({ deviceId }),
      setFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),
      setPreviewScroll: (messageId, top) =>
        set((state) => ({ previewScroll: { ...state.previewScroll, [messageId]: top } })),
      setList: (messages, nextCursor, revision) =>
        set((state) => ({
          messages: sortMessagesDesc(messages.filter((item) => !isExpiredMessage(item))).slice(0, MAX_MESSAGES),
          nextCursor,
          listLoaded: true,
          // 快照是服务端基线：墓碑清空（快照里没有的就是真没有），rev 只升不降
          lastRev: Math.max(state.lastRev, revision ?? maxMessageRev(messages)),
          deletedRev: {},
        })),
      appendList: (messages, nextCursor, revision) =>
        set((state) => {
          const seen = new Set(state.messages.map((item) => item.id))
          const fresh = messages.filter((item) => !seen.has(item.id) && !isExpiredMessage(item))
          return {
            messages: sortMessagesDesc([...state.messages, ...fresh]).slice(0, MAX_MESSAGES),
            nextCursor,
            lastRev: Math.max(state.lastRev, revision ?? maxMessageRev(messages)),
          }
        }),
      applyInboxCreated: (message, rev) => {
        const gate = revGate(get().lastRev, rev)
        if (gate !== 'apply') return gate
        if (isExpiredMessage(message)) return 'applied'
        const tombstone = get().deletedRev[message.id]
        if (tombstone && (rev === undefined || rev <= tombstone)) return 'stale'
        set((state) => ({
          messages: sortMessagesDesc(
            state.messages.some((item) => item.id === message.id)
              ? state.messages.map((item) => (item.id === message.id ? message : item))
              : [...state.messages, message],
          ).slice(0, MAX_MESSAGES),
          lastRev: nextRev(state.lastRev, rev),
        }))
        return 'applied'
      },
      applyInboxUpdated: (messages, rev) => {
        const gate = revGate(get().lastRev, rev)
        if (gate !== 'apply') return gate
        set((state) => {
          // update 不创造消息：已删（墓碑）或未知 id 一律忽略，防复活/乱序
          const patch = new Map(
            messages.filter((m) => !isExpiredMessage(m) && !(m.id in state.deletedRev)).map((m) => [m.id, m]),
          )
          if (!patch.size) return { lastRev: nextRev(state.lastRev, rev) }
          const nextMessages = sortMessagesDesc(state.messages.map((item) => patch.get(item.id) || item)).slice(
            0,
            MAX_MESSAGES,
          )
          const tabs = state.tabs.map((tab) =>
            patch.has(tab.id)
              ? { ...tab, title: inboxMessageTitle(patch.get(tab.id)!) || tab.title, type: patch.get(tab.id)!.type }
              : tab,
          )
          return { messages: nextMessages, tabs, lastRev: nextRev(state.lastRev, rev) }
        })
        return 'applied'
      },
      applyInboxDeleted: (ids, rev) => {
        const gate = revGate(get().lastRev, rev)
        if (gate !== 'apply') return gate
        get().removeMessages(ids)
        set((state) => {
          const deletedRev = { ...state.deletedRev }
          for (const id of ids) deletedRev[id] = rev ?? state.lastRev + 1
          // 墓碑集合有界：超出丢最老（对象 key 保序）
          const keys = Object.keys(deletedRev)
          if (keys.length > MAX_DELETED_REV)
            for (const key of keys.slice(0, keys.length - MAX_DELETED_REV)) delete deletedRev[key]
          return { deletedRev, lastRev: nextRev(state.lastRev, rev) }
        })
        return 'applied'
      },
      upsertMessage: (message) =>
        set((state) => {
          if (isExpiredMessage(message)) return { messages: state.messages.filter((item) => item.id !== message.id) }
          const exists = state.messages.some((item) => item.id === message.id)
          const next = exists
            ? state.messages.map((item) => (item.id === message.id ? { ...message } : item))
            : [...state.messages, message]
          const nextMessages = sortMessagesDesc(next).slice(0, MAX_MESSAGES)
          // 打开的 tab 跟随最新 metadata（标题/类型可能变化）
          const tabs = state.tabs.some((tab) => tab.id === message.id)
            ? state.tabs.map((tab) =>
                tab.id === message.id
                  ? { ...tab, title: inboxMessageTitle(message) || tab.title, type: message.type }
                  : tab,
              )
            : state.tabs
          return { messages: nextMessages, tabs }
        }),
      removeMessages: (ids) =>
        set((state) => {
          const removed = new Set(ids)
          const removedUnread = state.messages.filter(
            (item) => removed.has(item.id) && isInboxUnread(item, state.deviceId),
          ).length
          const tabs = state.tabs.filter((tab) => !removed.has(tab.id))
          return {
            messages: state.messages.filter((item) => !removed.has(item.id)),
            unreadCount: Math.max(0, state.unreadCount - removedUnread),
            tabs,
            activeTabId: state.activeTabId && removed.has(state.activeTabId) ? null : state.activeTabId,
          }
        }),
      setUnreadCount: (count) => set({ unreadCount: Math.max(0, count) }),
      markReadLocal: (ids) => {
        const marked = new Set(ids)
        const now = new Date().toISOString()
        let changed = 0
        set((state) => ({
          messages: state.messages.map((item) => {
            // 全局已读：本端乐观写入 readAt，其他端靠 WS update 同步消除未读。
            // 回收站消息不计角标，跳过防扣错数
            if (!marked.has(item.id) || item.deletedAt || !isInboxUnread(item, state.deviceId)) return item
            changed += 1
            const readBy = item.readBy.includes(state.deviceId) ? item.readBy : [...item.readBy, state.deviceId]
            return { ...item, readBy, readAt: item.readAt || now, updatedAt: now }
          }),
          unreadCount: state.unreadCount,
        }))
        if (changed) set((state) => ({ unreadCount: Math.max(0, state.unreadCount - changed) }))
        return changed
      },
      // 标未读：清 readAt+readBy（同服务端全局语义），未读角标同步加回
      markUnreadLocal: (ids) => {
        const marked = new Set(ids)
        const now = new Date().toISOString()
        let changed = 0
        set((state) => ({
          messages: state.messages.map((item) => {
            if (!marked.has(item.id) || item.deletedAt || !item.readAt) return item
            changed += 1
            return { ...item, readAt: undefined, readBy: [], updatedAt: now }
          }),
        }))
        if (changed) set((state) => ({ unreadCount: state.unreadCount + changed }))
        return changed
      },
      // 归档乐观写入：镜像服务端 guard（未读/回收站不归档），失败回源回滚
      archiveLocal: (ids, archived) => {
        const marked = new Set(ids)
        const now = new Date().toISOString()
        let changed = 0
        set((state) => ({
          messages: state.messages.map((item) => {
            if (!marked.has(item.id) || item.deletedAt) return item
            if (archived) {
              if (!item.readAt || item.archivedAt) return item
              changed += 1
              return { ...item, archivedAt: now, updatedAt: now }
            }
            if (!item.archivedAt) return item
            changed += 1
            return { ...item, archivedAt: undefined, updatedAt: now }
          }),
        }))
        return changed
      },
      // 回收站乐观写入：软删可恢复；未读进回收站扣角标，恢复未读回补角标
      trashLocal: (ids, deleted) => {
        const marked = new Set(ids)
        const now = new Date().toISOString()
        let changed = 0
        let unreadDelta = 0
        set((state) => {
          const messages = state.messages.map((item) => {
            if (!marked.has(item.id) || !!item.deletedAt === deleted) return item
            changed += 1
            if (isInboxUnread(item, state.deviceId)) unreadDelta += deleted ? 1 : -1
            return { ...item, deletedAt: deleted ? now : undefined, updatedAt: now }
          })
          return { messages, unreadCount: Math.max(0, state.unreadCount - unreadDelta) }
        })
        return changed
      },
      setStats: (stats) => set({ stats }),
      beginSync: () => set((state) => ({ pendingSync: state.pendingSync + 1 })),
      endSync: (error) => set((state) => ({ pendingSync: Math.max(0, state.pendingSync - 1), syncError: !!error })),
      // 关闭全部已打开 = 只清右侧预览 tab：纯本地 UI 态，不发事件不动消息
      closeAllTabs: () => set({ tabs: [], activeTabId: null }),
      setPanelOpen: (open) => set({ panelOpen: open }),
      openTab: (message) =>
        set((state) => {
          const existing = state.tabs.find((tab) => tab.id === message.id)
          const tab = tabFromMessage(message, existing)
          // 未 pin 的超额 tab 从最久未打开的开始淘汰，pin 的不动
          let tabs = existing ? state.tabs.map((item) => (item.id === tab.id ? tab : item)) : [...state.tabs, tab]
          if (tabs.length > MAX_TABS) {
            const evictable = tabs
              .filter((item) => !item.pinned && item.id !== tab.id)
              .sort((a, b) => a.lastOpenedAt.localeCompare(b.lastOpenedAt))
            const drop = new Set(evictable.slice(0, tabs.length - MAX_TABS).map((item) => item.id))
            tabs = tabs.filter((item) => !drop.has(item.id))
          }
          return { tabs, activeTabId: tab.id }
        }),
      openTabById: async (messageId) => {
        const cached = get().messages.find((item) => item.id === messageId) || null
        const message =
          cached ||
          (await api.inbox
            .get(messageId)
            .then((res) => res.message)
            .catch(() => null))
        if (!message || isExpiredMessage(message)) return null
        get().openTab(message)
        return message
      },
      closeTab: (id) =>
        set((state) => ({
          tabs: state.tabs.filter((tab) => tab.id !== id),
          activeTabId: state.activeTabId === id ? null : state.activeTabId,
        })),
      setActiveTab: (id) =>
        set((state) => ({
          activeTabId: id && state.tabs.some((tab) => tab.id === id) ? id : null,
        })),
      togglePinTab: (id) =>
        set((state) => ({
          tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)),
        })),
      // 持久化 tab 按 id 重新 hydrate：404/过期剔除，存活者刷新 metadata
      hydrateTabs: async () => {
        const tabs = get().tabs
        if (!tabs.length) return
        const results = await Promise.all(
          tabs.map((tab) =>
            api.inbox
              .get(tab.id)
              .then((res) => res.message)
              .catch(() => null),
          ),
        )
        const byId = new Map(
          results.filter((m): m is AgentInboxMessage => !!m && !isExpiredMessage(m)).map((m) => [m.id, m]),
        )
        set((state) => ({
          tabs: state.tabs
            .filter((tab) => byId.has(tab.id))
            .map((tab) => {
              const message = byId.get(tab.id)!
              return { ...tab, title: inboxMessageTitle(message) || tab.title, type: message.type }
            }),
          activeTabId: state.activeTabId && byId.has(state.activeTabId) ? state.activeTabId : null,
        }))
      },
    }),
    {
      name: INBOX_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => createDebouncedStorage(120)),
      // 只持久化 tab 元数据；消息镜像/未读数重启后一律经 REST 重建
      partialize: (state) => ({ tabs: state.tabs, activeTabId: state.activeTabId }),
      merge: (persisted, current) => {
        const persistedState = (persisted || {}) as Partial<InboxState>
        const tabs = Array.isArray(persistedState.tabs) ? persistedState.tabs.filter(isValidTab) : []
        const tabIds = new Set(tabs.map((tab) => tab.id))
        return {
          ...current,
          tabs,
          activeTabId:
            persistedState.activeTabId && tabIds.has(persistedState.activeTabId) ? persistedState.activeTabId : null,
        }
      },
    },
  ),
)
