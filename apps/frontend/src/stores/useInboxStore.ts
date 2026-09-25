import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '@/lib/persist-storage'
import { detectDeviceKind } from '@/lib/console-device-state'
import { api } from '@/lib/api'
import type { AgentInboxMessage, InboxTab } from '@/types'

const INBOX_STORAGE_KEY = `tmuxgo-inbox-state:${detectDeviceKind()}`
const MAX_TABS = 20
const MAX_MESSAGES = 500

function isExpiredMessage(message: AgentInboxMessage, now = Date.now()) {
  return !!message.expiresAt && Date.parse(message.expiresAt) < now
}
// 列表镜像统一按 createdAt 倒序（新→旧），id 做同刻稳定 tiebreak
function sortMessagesDesc(list: AgentInboxMessage[]) {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
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
  setDeviceId: (deviceId: string) => void
  setList: (messages: AgentInboxMessage[], nextCursor: string | null) => void
  appendList: (messages: AgentInboxMessage[], nextCursor: string | null) => void
  upsertMessage: (message: AgentInboxMessage) => void
  removeMessages: (ids: string[]) => void
  setUnreadCount: (count: number) => void
  markReadLocal: (ids: string[]) => number
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
      setDeviceId: (deviceId) => set({ deviceId }),
      setList: (messages, nextCursor) =>
        set({
          messages: sortMessagesDesc(messages.filter((item) => !isExpiredMessage(item))).slice(0, MAX_MESSAGES),
          nextCursor,
          listLoaded: true,
        }),
      appendList: (messages, nextCursor) =>
        set((state) => {
          const seen = new Set(state.messages.map((item) => item.id))
          const fresh = messages.filter((item) => !seen.has(item.id) && !isExpiredMessage(item))
          return {
            messages: sortMessagesDesc([...state.messages, ...fresh]).slice(0, MAX_MESSAGES),
            nextCursor,
          }
        }),
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
            (item) => removed.has(item.id) && !item.readBy.includes(state.deviceId),
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
        let changed = 0
        set((state) => ({
          messages: state.messages.map((item) => {
            if (!marked.has(item.id) || item.readBy.includes(state.deviceId)) return item
            changed += 1
            return { ...item, readBy: [...item.readBy, state.deviceId] }
          }),
          unreadCount: state.unreadCount,
        }))
        if (changed) set((state) => ({ unreadCount: Math.max(0, state.unreadCount - changed) }))
        return changed
      },
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
