import { createHash } from 'crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import webPush from 'web-push'
import type { AgentPaneState } from './agent-state.js'

export interface AgentNotificationRecord {
  id: string
  eventId: string
  hostId: string
  sessionName: string
  paneId: string
  agent: string
  status: 'blocked' | 'done' | 'permission_required' | 'needs_input' | 'failed' | 'ended' | 'disconnected'
  title?: string
  message: string
  timestamp: string
  readBy: string[]
  // 待办队列（agent v2 P2，docs/architecture/agent-observability-v2.md §4）：
  // kind='info' 是纯状态播报（不进待办三段视图），'todo' 才是「等着人处理/回看」的项
  kind?: 'todo' | 'info'
  // pending=进行中、blocked=需人处理、done=已终结（含 pane 消失）
  todoState?: 'pending' | 'blocked' | 'done'
  // 写入时从 pane 的 @tmuxgo_task 快照，不做关联查询（任务号后改不影响历史待办）
  task?: string
}
export interface AgentPushSubscription {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}
interface StoredSubscription extends AgentPushSubscription {
  id: string
  deviceId: string
  createdAt: string
  updatedAt: string
}
interface NotificationStore {
  version: 1
  vapid: { subject: string; publicKey: string; privateKey: string }
  subscriptions: StoredSubscription[]
  notifications: AgentNotificationRecord[]
}
interface MonitorNotificationEvent {
  type: 'agent_notification'
  hostId: string
  sessionName: string
  pane: AgentPaneState
  eventId: string
}
const STORE_VERSION = 1
let store: NotificationStore | null = null
let storePromise: Promise<NotificationStore> | null = null
let loadedStorePath: string | null = null
let savePromise: Promise<void> = Promise.resolve()
let saveSequence = 0
// web-push 订阅者数量缓存：agent-monitor 用它决定空闲轮询档位（5s vs 30s）。
// 读侧必须同步且零 IO，写入侧在 loadStore/register/revoke/失效清理处更新
let pushSubscriberCount = 0
const pushSubscriberListeners = new Set<() => void>()
function configDir() {
  return process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo')
}
function storePath() {
  return path.join(configDir(), 'agent-notifications.json')
}
export function getPushSubscriberCount() {
  return pushSubscriberCount
}
export function onPushSubscriberChange(listener: () => void) {
  pushSubscriberListeners.add(listener)
  return () => {
    pushSubscriberListeners.delete(listener)
  }
}
function setPushSubscriberCount(count: number) {
  if (count === pushSubscriberCount) return
  pushSubscriberCount = count
  for (const listener of [...pushSubscriberListeners]) {
    try {
      listener()
    } catch {}
  }
}
// 只读探测：启动时判断是否需要 5s 档。刻意不调 loadStore()——它在无存储文件时
// 会生成 VAPID 并落盘，轮询节拍不该有这个副作用
export async function refreshPushSubscriberCount() {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as { subscriptions?: unknown }
    setPushSubscriberCount(Array.isArray(parsed.subscriptions) ? parsed.subscriptions.length : 0)
  } catch {
    setPushSubscriberCount(0)
  }
  return pushSubscriberCount
}
export function normalizeAgentDeviceId(value: unknown) {
  if (typeof value !== 'string') throw new Error('Invalid device id')
  const deviceId = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) throw new Error('Invalid device id')
  return deviceId
}
function normalizeSubscription(value: unknown): AgentPushSubscription | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const keys = item.keys && typeof item.keys === 'object' ? (item.keys as Record<string, unknown>) : {}
  if (
    typeof item.endpoint !== 'string' ||
    !item.endpoint.startsWith('https://') ||
    item.endpoint.length < 20 ||
    item.endpoint.length > 4096 ||
    typeof keys.p256dh !== 'string' ||
    keys.p256dh.length < 1 ||
    typeof keys.auth !== 'string' ||
    keys.auth.length < 1 ||
    keys.p256dh.length > 512 ||
    keys.auth.length > 512
  )
    return null
  return {
    endpoint: item.endpoint,
    expirationTime: typeof item.expirationTime === 'number' ? item.expirationTime : null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  }
}
function newStore(): NotificationStore {
  const keys = webPush.generateVAPIDKeys()
  return {
    version: STORE_VERSION,
    vapid: { subject: process.env.TMUXGO_WEB_PUSH_SUBJECT?.trim() || 'mailto:admin@tmuxgo.local', ...keys },
    subscriptions: [],
    notifications: [],
  }
}
async function writeStore(value: NotificationStore, targetPath: string) {
  const directory = path.dirname(targetPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = `${targetPath}.${process.pid}.${++saveSequence}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, targetPath)
  await chmod(targetPath, 0o600)
}
async function saveStore(value: NotificationStore) {
  const targetPath = storePath()
  const pending = savePromise.then(
    () => writeStore(value, targetPath),
    () => writeStore(value, targetPath),
  )
  savePromise = pending.then(
    () => undefined,
    () => undefined,
  )
  await pending
}
async function loadStore() {
  const currentPath = storePath()
  if (store && loadedStorePath === currentPath) return store
  if (loadedStorePath !== currentPath) store = null
  if (storePromise) return storePromise
  storePromise = (async () => {
    let loaded: NotificationStore | null = null
    try {
      const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<NotificationStore>
      if (
        parsed.version === STORE_VERSION &&
        parsed.vapid &&
        typeof parsed.vapid.publicKey === 'string' &&
        typeof parsed.vapid.privateKey === 'string' &&
        Array.isArray(parsed.subscriptions) &&
        Array.isArray(parsed.notifications)
      )
        loaded = parsed as NotificationStore
    } catch {}
    store = loaded || newStore()
    loadedStorePath = currentPath
    store.subscriptions = store.subscriptions
      .filter(
        (item) =>
          normalizeSubscription(item) !== null && typeof item.id === 'string' && typeof item.deviceId === 'string',
      )
      .map((item) => ({ ...item, ...normalizeSubscription(item)! }))
    store.notifications = store.notifications
      .filter(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          typeof item.eventId === 'string' &&
          typeof item.hostId === 'string' &&
          typeof item.sessionName === 'string' &&
          typeof item.paneId === 'string' &&
          Array.isArray(item.readBy),
      )
      .slice(0, 500)
    setPushSubscriberCount(store.subscriptions.length)
    await saveStore(store)
    return store
  })().finally(() => {
    storePromise = null
  })
  return storePromise
}
function notificationStatus(pane: AgentPaneState): AgentNotificationRecord['status'] | null {
  if (pane.phase === 'permission_required' || pane.lastEvent === 'permission_required') return 'permission_required'
  if (pane.phase === 'needs_input' || pane.lastEvent === 'question_required') return 'needs_input'
  if (pane.phase === 'failed' || pane.lastEvent === 'failed') return 'failed'
  if (pane.phase === 'ended' || pane.lastEvent === 'ended') return 'ended'
  if (pane.phase === 'disconnected' || pane.lastEvent === 'disconnected') return 'disconnected'
  if (pane.lastEvent === 'completed' || pane.agentStatus === 'done') return 'done'
  if (pane.agentStatus === 'blocked') return 'blocked'
  return null
}
/**
 * 通知状态 → 待办语义。纯函数，写入与「读时懒迁移」共用同一份规则，
 * 保证历史数据不需要停机脚本也能被 Tasks 视图正确归类。
 */
export function todoStateOf(status: AgentNotificationRecord['status']): 'pending' | 'blocked' | 'done' {
  if (status === 'permission_required' || status === 'needs_input' || status === 'blocked') return 'blocked'
  if (status === 'done' || status === 'ended' || status === 'failed') return 'done'
  return 'pending'
}
// 断连/纯播报不算待办：disconnected 是环境状态，处理它没有「打勾」这个动作
export function kindOf(status: AgentNotificationRecord['status']): 'todo' | 'info' {
  return status === 'disconnected' ? 'info' : 'todo'
}
// 读时懒迁移：老记录没有这三个字段，按同一份规则补出来（不写回，避免读路径产生 IO）
export function normalizeNotification(record: AgentNotificationRecord): AgentNotificationRecord {
  return {
    ...record,
    kind: record.kind ?? kindOf(record.status),
    todoState: record.todoState ?? todoStateOf(record.status),
  }
}
function publicMessage(status: AgentNotificationRecord['status'], agent: string) {
  const messages: Record<AgentNotificationRecord['status'], string> = {
    blocked: `${agent} is waiting for attention`,
    done: `${agent} completed a turn`,
    permission_required: `${agent} is waiting for permission`,
    needs_input: `${agent} is waiting for input`,
    failed: `${agent} reported a failure`,
    ended: `${agent} ended`,
    disconnected: `${agent} disconnected`,
  }
  return messages[status]
}
function subscriptionId(deviceId: string, endpoint: string) {
  return createHash('sha256').update(`${deviceId}:${endpoint}`).digest('hex').slice(0, 32)
}
function configurePush(value: NotificationStore) {
  webPush.setVapidDetails(value.vapid.subject, value.vapid.publicKey, value.vapid.privateKey)
}
async function sendPush(value: NotificationStore, notification: AgentNotificationRecord) {
  configurePush(value)
  const payload = JSON.stringify({
    type: 'agent_notification',
    id: notification.id,
    hostId: notification.hostId,
    sessionName: notification.sessionName,
    paneId: notification.paneId,
    agent: notification.agent,
    status: notification.status,
    title: notification.title,
    message: notification.message,
    timestamp: notification.timestamp,
    url: `/?hostId=${encodeURIComponent(notification.hostId)}&sessionName=${encodeURIComponent(notification.sessionName)}&paneId=${encodeURIComponent(notification.paneId)}&notificationId=${encodeURIComponent(notification.id)}`,
  })
  const removed = new Set<string>()
  await Promise.all(
    value.subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, payload)
      } catch (error) {
        const statusCode =
          error && typeof error === 'object' && 'statusCode' in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : 0
        if (statusCode === 404 || statusCode === 410) removed.add(subscription.id)
      }
    }),
  )
  if (removed.size) {
    value.subscriptions = value.subscriptions.filter((subscription) => !removed.has(subscription.id))
    setPushSubscriberCount(value.subscriptions.length)
    await saveStore(value)
  }
}
export async function getAgentPushPublicKey() {
  const value = await loadStore()
  return value.vapid.publicKey
}
export async function registerAgentPushSubscription(deviceIdRaw: string, raw: unknown) {
  const deviceId = normalizeAgentDeviceId(deviceIdRaw)
  const subscription = normalizeSubscription(raw)
  if (!subscription) throw new Error('Invalid push subscription')
  const value = await loadStore()
  const id = subscriptionId(deviceId, subscription.endpoint)
  const now = new Date().toISOString()
  const previous = value.subscriptions.find((item) => item.id === id)
  const next: StoredSubscription = {
    ...subscription,
    id,
    deviceId,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  }
  value.subscriptions = [...value.subscriptions.filter((item) => item.id !== id), next]
  setPushSubscriberCount(value.subscriptions.length)
  await saveStore(value)
  return { id, deviceId, endpoint: subscription.endpoint, updatedAt: now }
}
export async function revokeAgentPushSubscription(id: string, deviceId?: string) {
  const value = await loadStore()
  const before = value.subscriptions.length
  value.subscriptions = value.subscriptions.filter(
    (item) => !(item.id === id && (!deviceId || item.deviceId === deviceId)),
  )
  if (value.subscriptions.length !== before) {
    setPushSubscriberCount(value.subscriptions.length)
    await saveStore(value)
  }
  return value.subscriptions.length !== before
}
export async function listUnreadAgentNotifications(deviceId: string, limit = 100) {
  deviceId = normalizeAgentDeviceId(deviceId)
  const value = await loadStore()
  return value.notifications
    .filter((item) => !item.readBy.includes(deviceId))
    .slice(0, Math.max(1, Math.min(200, limit)))
}
export interface AgentTodoItem extends AgentNotificationRecord {
  kind: 'todo'
  todoState: 'pending' | 'blocked' | 'done'
}
export interface AgentTodoQueue {
  blocked: AgentTodoItem[]
  pending: AgentTodoItem[]
  done: AgentTodoItem[]
  counts: { blocked: number; pending: number; done: number }
}
/**
 * 待办队列：按 paneId 聚合，每个 pane 只留「最新一条」待办。
 * 通知本身全量留存（回看/审计都在原列表），这里只是视图层的投影：
 * 同一 pane 连续 blocked → working → done 不会在队列里堆三行。
 */
export async function listAgentTodoQueue(options: { doneLimit?: number } = {}): Promise<AgentTodoQueue> {
  const value = await loadStore()
  const latestByPane = new Map<string, AgentTodoItem>()
  // notifications 是「新在前」，首个命中的就是该 pane 最新的一条
  for (const raw of value.notifications) {
    const record = normalizeNotification(raw)
    if (record.kind !== 'todo') continue
    const item = record as AgentTodoItem
    if (latestByPane.has(item.paneId)) continue
    latestByPane.set(item.paneId, item)
  }
  const items = [...latestByPane.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  const blocked = items.filter((item) => item.todoState === 'blocked')
  const pending = items.filter((item) => item.todoState === 'pending')
  const doneLimit = Math.max(1, Math.min(200, options.doneLimit ?? 50))
  const done = items.filter((item) => item.todoState === 'done').slice(0, doneLimit)
  return {
    blocked,
    pending,
    done,
    counts: { blocked: blocked.length, pending: pending.length, done: done.length },
  }
}
const blockedPhases = new Set(['permission_required', 'needs_input'])
const runningPhases = new Set(['working', 'retrying', 'idle'])
/**
 * 用 monitor 的实时阶段纠正待办分类：
 * 通知是「那一刻发生了什么」的快照，用户看到队列时 agent 可能已经自己继续跑了。
 * blocked 的 pane 若已回到 working/idle，降级为 pending（不用人管，等它跑完）；
 * pending 的 pane 若已卡在 permission/needs_input，升级为 blocked（及早上浮）。
 * pane 已不在实时状态里不在这里处理——那由 onPaneRemoved → closeAgentTodosForPane 收口。
 */
export function reconcileTodoQueue(
  queue: AgentTodoQueue,
  live: Map<string, { phase?: string; agentStatus?: string }>,
): AgentTodoQueue {
  const blocked: AgentTodoItem[] = []
  const pending: AgentTodoItem[] = [...queue.pending]
  for (const item of queue.blocked) {
    const state = live.get(item.paneId)
    const phase = state?.phase
    if (phase && runningPhases.has(phase)) pending.push({ ...item, todoState: 'pending' })
    else blocked.push(item)
  }
  for (const item of queue.pending) {
    const state = live.get(item.paneId)
    const phase = state?.phase
    if ((phase && blockedPhases.has(phase)) || state?.agentStatus === 'blocked') {
      blocked.push({ ...item, todoState: 'blocked' })
    }
  }
  const pendingAfterEscalation = pending.filter((item) => !blocked.some((entry) => entry.id === item.id))
  const byTime = (a: AgentTodoItem, b: AgentTodoItem) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
  blocked.sort(byTime)
  pendingAfterEscalation.sort(byTime)
  return {
    blocked,
    pending: pendingAfterEscalation,
    done: queue.done,
    counts: { blocked: blocked.length, pending: pendingAfterEscalation.length, done: queue.done.length },
  }
}
/**
 * pane 消失 → 该 pane 的未完成待办全部转 done。
 * 不能只靠扫描：pane 没了就再也扫不到它，通知流也不会再为它产生事件。
 */
export async function closeAgentTodosForPane(hostId: string, paneId: string) {
  const value = await loadStore()
  let changed = 0
  for (const record of value.notifications) {
    if (record.hostId !== hostId || record.paneId !== paneId) continue
    const normalized = normalizeNotification(record)
    if (normalized.todoState === 'done') continue
    record.kind = normalized.kind
    record.todoState = 'done'
    changed++
  }
  if (changed) await saveStore(value)
  return changed
}
/**
 * 清空已完成待办：把推导为 done 的通知记录从存储里删掉（不是改状态、不是标记已读）。
 * 判定必须走 normalizeNotification + todoStateOf 这同一份推导：队列视图就是按它分类的，
 * 若这里另写一套条件（比如只看 status==='done'），ended/failed 与 pane 消失收口的记录会漏掉，
 * 用户按「队列里显示 3 条 done」去清，结果只清掉 1 条。
 * hostId 缺省为全部 host；返回值带删掉的条数与命中的 host，供审计记录范围。
 */
export async function clearDoneAgentTodos(options: { hostId?: string } = {}) {
  const value = await loadStore()
  const kept: AgentNotificationRecord[] = []
  const hosts = new Set<string>()
  let removed = 0
  for (const record of value.notifications) {
    if (options.hostId && record.hostId !== options.hostId) {
      kept.push(record)
      continue
    }
    const normalized = normalizeNotification(record)
    // kind='info'（disconnected 播报）本来就不进待办队列，即便推导成 done 也不该被「清待办」带走
    if (normalized.kind === 'todo' && normalized.todoState === 'done') {
      removed++
      if (record.hostId) hosts.add(record.hostId)
      continue
    }
    kept.push(record)
  }
  if (removed) {
    value.notifications = kept
    await saveStore(value)
  }
  return { removed, hosts: [...hosts].sort() }
}
export async function markAgentNotificationsRead(deviceIdRaw: string, ids: string[]) {
  const deviceId = normalizeAgentDeviceId(deviceIdRaw)
  const selected = new Set(ids.filter((id) => typeof id === 'string' && id.length <= 256))
  const value = await loadStore()
  let changed = 0
  for (const item of value.notifications) {
    if (selected.size && !selected.has(item.id)) continue
    if (item.readBy.includes(deviceId)) continue
    item.readBy = [...item.readBy, deviceId].slice(-32)
    changed++
  }
  if (changed) await saveStore(value)
  return changed
}
export async function persistAgentNotification(event: MonitorNotificationEvent) {
  const status = notificationStatus(event.pane)
  if (!status || !event.eventId) return null
  const value = await loadStore()
  const existing = value.notifications.find((item) => item.id === event.eventId)
  if (existing) return existing
  const timestamp = event.pane.updatedAt || new Date().toISOString()
  const notification: AgentNotificationRecord = {
    id: event.eventId,
    eventId: event.eventId,
    hostId: event.hostId,
    sessionName: event.sessionName,
    paneId: event.pane.paneId,
    agent: event.pane.agent,
    status,
    title: event.pane.display?.title,
    message: event.pane.message || publicMessage(status, event.pane.agent),
    timestamp,
    readBy: [],
    kind: kindOf(status),
    todoState: todoStateOf(status),
    // 任务号快照：pane 上没绑定就是 undefined，UI 那列显示 —（不写空串）
    task: event.pane.task,
  }
  value.notifications = [notification, ...value.notifications].slice(0, 500)
  await saveStore(value)
  await sendPush(value, notification)
  return notification
}
