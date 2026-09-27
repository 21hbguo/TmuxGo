'use client'
import { useEffect, useRef } from 'react'
import { subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { api } from '@/lib/api'
import { getDeviceId } from '@/lib/agent-push'
import { useInboxStore, isInboxUnread, isInboxTrashed } from '@/stores/useInboxStore'
import type { AgentInboxMessage } from '@/types'

const INBOX_PAGE_SIZE = 100
const UNREAD_REFRESH_DEBOUNCE_MS = 400
let unreadRefreshTimer: ReturnType<typeof setTimeout> | null = null
// 列表同步世代号：任何先于最近一次 list 响应发出的 unreadCount 请求都是
// 过期数据，晚到时不得覆盖（移动端慢网下 stale-0 会清掉刚对账出的角标）
let listSyncEpoch = 0

export async function refreshInboxList(cursor?: string) {
  const store = useInboxStore.getState()
  store.beginSync()
  try {
    const res = await api.inbox.list({
      deviceId: store.deviceId || undefined,
      // 镜像是全量：归档/回收站也进 mirror，panel 的 filter 决定哪面可见
      view: 'all',
      limit: INBOX_PAGE_SIZE,
      cursor,
    })
    listSyncEpoch += 1
    // 快照落后于已应用的事件（请求发出期间有新变更）：不回退，等下轮对账
    if (typeof res.revision === 'number' && res.revision < useInboxStore.getState().lastRev) {
      store.endSync()
      return res
    }
    if (cursor) store.appendList(res.messages, res.nextCursor, res.revision)
    else store.setList(res.messages, res.nextCursor, res.revision)
    if (typeof res.unreadCount === 'number') store.setUnreadCount(res.unreadCount)
    if (res.stats) store.setStats(res.stats)
    store.endSync()
    return res
  } catch (error) {
    store.endSync(true)
    throw error
  }
}
// 事件合流后本地重算未读角标：已读/删除/新到消息统一收敛
function recountUnread() {
  const state = useInboxStore.getState()
  state.setUnreadCount(
    state.messages.filter((item) => isInboxUnread(item, state.deviceId) && !isInboxTrashed(item)).length,
  )
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

// 乐观变更统一收口：本地先记账（badge 即时），REST 挂 pendingSync，
// 失败回源快照回滚（服务端才是权威）；WS updated 事件带 rev+权威态自会对账
function optimisticInboxMutation<T>(mutate: () => Promise<T>) {
  const store = useInboxStore.getState()
  store.beginSync()
  return mutate()
    .then((res) => {
      useInboxStore.getState().endSync()
      return res
    })
    .catch((error) => {
      useInboxStore.getState().endSync(true)
      void refreshInboxList().catch(() => {})
      throw error
    })
}

export function markInboxRead(ids: string[], read = true) {
  const store = useInboxStore.getState()
  const changed = read ? store.markReadLocal(ids) : store.markUnreadLocal(ids)
  if (changed) void optimisticInboxMutation(() => api.inbox.markReadBatch(ids, store.deviceId, read)).catch(() => {})
  return changed
}
// 删除=进回收站（软删），恢复/彻底删除是独立操作
export function deleteInboxMessages(ids: string[]) {
  const store = useInboxStore.getState()
  store.trashLocal(ids, true)
  void optimisticInboxMutation(() => api.inbox.remove(ids)).catch(() => {})
}
export function restoreInboxMessages(ids: string[]) {
  const store = useInboxStore.getState()
  store.trashLocal(ids, false)
  void optimisticInboxMutation(() => api.inbox.restore(ids)).catch(() => {})
}
export function purgeInboxMessages(ids: string[]) {
  const store = useInboxStore.getState()
  store.removeMessages(ids)
  void optimisticInboxMutation(() => api.inbox.purge(ids)).catch(() => {})
}
// 归档/恢复：乐观写 archivedAt（未读/回收站项被服务端跳过），
// 失败回源快照回滚。归档后其他端靠 inbox_message_updated+rev 同步
export function archiveInboxMessages(ids: string[], archived = true) {
  const store = useInboxStore.getState()
  const changed = store.archiveLocal(ids, archived)
  if (changed)
    void optimisticInboxMutation(() => api.inbox.archive(ids, archived))
      .then((res) => {
        // 服务端跳过了未读项：差异靠回源对账收正
        if (res.skippedUnread > 0) void refreshInboxList().catch(() => {})
      })
      .catch(() => {})
  return changed
}

function isUnreadForDevice(message: AgentInboxMessage, deviceId: string) {
  return isInboxUnread(message, deviceId)
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
    const handleCreated = (detail: { message?: AgentInboxMessage; rev?: number }) => {
      const message = detail?.message
      if (!message?.id) return
      const state = useInboxStore.getState()
      const known = state.messages.some((item) => item.id === message.id)
      const verdict = state.applyInboxCreated(message, detail.rev)
      // rev 跳号 = 丢事件：整个回源快照，不在这条事件上硬拼
      if (verdict === 'gap') return void refreshInboxList().catch(() => {})
      if (verdict !== 'applied') return
      if (!known && isUnreadForDevice(message, state.deviceId)) {
        useInboxStore.getState().setUnreadCount(state.unreadCount + 1)
        onMessageCreatedRef.current?.(message)
      } else scheduleUnreadRefresh()
    }
    const handleUpdated = (detail: { message?: AgentInboxMessage; messages?: AgentInboxMessage[]; rev?: number }) => {
      // 兼容旧单条 payload 与新的批量 payload
      const batch = detail?.messages || (detail?.message ? [detail.message] : [])
      if (!batch.length) return
      const state = useInboxStore.getState()
      const verdict = state.applyInboxUpdated(batch, detail.rev)
      if (verdict === 'gap') return void refreshInboxList().catch(() => {})
      if (verdict !== 'applied') return
      recountUnread()
    }
    const handleDeleted = (detail: { ids?: string[]; rev?: number }) => {
      const ids = detail?.ids
      if (!Array.isArray(ids) || !ids.length) return
      const verdict = useInboxStore.getState().applyInboxDeleted(ids, detail.rev)
      if (verdict === 'gap') void refreshInboxList().catch(() => {})
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
