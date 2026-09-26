'use client'
import { useEffect, useRef } from 'react'
import { subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { api } from '@/lib/api'
import { getDeviceId } from '@/lib/agent-push'
import { useInboxStore } from '@/stores/useInboxStore'
import type { AgentInboxMessage } from '@/types'

const INBOX_PAGE_SIZE = 100
const UNREAD_REFRESH_DEBOUNCE_MS = 400
let unreadRefreshTimer: ReturnType<typeof setTimeout> | null = null
// 列表同步世代号：任何先于最近一次 list 响应发出的 unreadCount 请求都是
// 过期数据，晚到时不得覆盖（移动端慢网下 stale-0 会清掉刚对账出的角标）
let listSyncEpoch = 0

export async function refreshInboxList(cursor?: string) {
  const store = useInboxStore.getState()
  const res = await api.inbox.list({
    deviceId: store.deviceId || undefined,
    limit: INBOX_PAGE_SIZE,
    cursor,
  })
  listSyncEpoch += 1
  if (cursor) store.appendList(res.messages, res.nextCursor)
  else store.setList(res.messages, res.nextCursor)
  if (typeof res.unreadCount === 'number') store.setUnreadCount(res.unreadCount)
  return res
}
export async function refreshInboxUnread() {
  const deviceId = useInboxStore.getState().deviceId
  if (!deviceId) return
  const epoch = listSyncEpoch
  const res = await api.inbox.unreadCount(deviceId).catch(() => null)
  if (res && epoch === listSyncEpoch) useInboxStore.getState().setUnreadCount(res.unreadCount)
}
// 事件风暴下每个事件一次 REST 太浪费，未读数刷新做去抖合并
export function scheduleUnreadRefresh() {
  if (unreadRefreshTimer) return
  unreadRefreshTimer = setTimeout(() => {
    unreadRefreshTimer = null
    void refreshInboxUnread()
  }, UNREAD_REFRESH_DEBOUNCE_MS)
}

// 先本地记账（badge/toast 即时），REST 失败时靠去抖刷新兜底
export function markInboxRead(ids: string[]) {
  const store = useInboxStore.getState()
  const changed = store.markReadLocal(ids)
  if (changed) void api.inbox.markReadBatch(ids, store.deviceId).catch(() => scheduleUnreadRefresh())
  return changed
}
export function deleteInboxMessages(ids: string[]) {
  const store = useInboxStore.getState()
  store.removeMessages(ids)
  void api.inbox.remove(ids).catch(() => void refreshInboxList())
}

function isUnreadForDevice(message: AgentInboxMessage, deviceId: string) {
  return !!deviceId && !message.readBy.includes(deviceId)
}

// WS 事件在断线/移动端后台休眠期间不重放：socket 死了推送全丢，
// 只靠开面板 REST 才补数 → 表现为「点进去再返回才有角标」。
// 重连（reconnected）与回前台（visibilitychange）都按 REST 对账兜底。
const RECONCILE_MIN_INTERVAL_MS = 2000

// inbox store 与 WS/REST 的同步入口：设备 id 初始化、首屏列表、tab hydrate、
// metadata 事件合流。挂载一次（InboxNotifications）。
export function useInboxSync(options: { onMessageCreated?: (message: AgentInboxMessage) => void } = {}) {
  const onMessageCreatedRef = useRef(options.onMessageCreated)
  onMessageCreatedRef.current = options.onMessageCreated
  useEffect(() => {
    const store = useInboxStore.getState()
    if (!store.deviceId) store.setDeviceId(getDeviceId())
    void store.hydrateTabs()
    // 首次 reconcile 必须放行（WS 首连/回前台正是需要对账的时机），只去抖风暴
    let lastSyncAt = 0
    if (!useInboxStore.getState().listLoaded) void refreshInboxList().catch(() => {})
    else void refreshInboxUnread()
    const reconcile = () => {
      const now = Date.now()
      if (now - lastSyncAt < RECONCILE_MIN_INTERVAL_MS) return
      lastSyncAt = now
      // 列表响应自带 unreadCount，一次 REST 同时补漏掉的消息与角标
      void refreshInboxList().catch(() => {
        lastSyncAt = 0
      })
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reconcile()
    }
    const handleCreated = (detail: { message?: AgentInboxMessage }) => {
      const message = detail?.message
      if (!message?.id) return
      const state = useInboxStore.getState()
      const known = state.messages.some((item) => item.id === message.id)
      state.upsertMessage(message)
      if (!known && isUnreadForDevice(message, state.deviceId)) {
        useInboxStore.getState().setUnreadCount(state.unreadCount + 1)
        onMessageCreatedRef.current?.(message)
      } else scheduleUnreadRefresh()
    }
    const handleUpdated = (detail: { message?: AgentInboxMessage }) => {
      const message = detail?.message
      if (!message?.id) return
      const state = useInboxStore.getState()
      const previous = state.messages.find((item) => item.id === message.id)
      state.upsertMessage(message)
      const wasUnread = previous ? isUnreadForDevice(previous, state.deviceId) : false
      const nowUnread = isUnreadForDevice(message, state.deviceId)
      if (wasUnread !== nowUnread) state.setUnreadCount(state.unreadCount + (nowUnread ? 1 : -1))
      else if (!previous) scheduleUnreadRefresh()
    }
    const handleDeleted = (detail: { ids?: string[] }) => {
      const ids = detail?.ids
      if (!Array.isArray(ids) || !ids.length) return
      useInboxStore.getState().removeMessages(ids)
    }
    const unsubs = [
      subscribeStreamEvent(STREAM_EVENT.inboxMessageCreated, handleCreated),
      subscribeStreamEvent(STREAM_EVENT.inboxMessageUpdated, handleUpdated),
      subscribeStreamEvent(STREAM_EVENT.inboxMessageDeleted, handleDeleted),
      subscribeStreamEvent(STREAM_EVENT.reconnected, reconcile),
    ]
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      for (const unsub of unsubs) unsub()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])
}
