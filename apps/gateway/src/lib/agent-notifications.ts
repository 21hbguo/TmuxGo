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
  message: string
  timestamp: string
  readBy: string[]
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
function configDir() {
  return process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo')
}
function storePath() {
  return path.join(configDir(), 'agent-notifications.json')
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
  const keys = item.keys && typeof item.keys === 'object' ? item.keys as Record<string, unknown> : {}
  if (typeof item.endpoint !== 'string' || !item.endpoint.startsWith('https://') || item.endpoint.length < 20 || item.endpoint.length > 4096 || typeof keys.p256dh !== 'string' || keys.p256dh.length < 1 || typeof keys.auth !== 'string' || keys.auth.length < 1 || keys.p256dh.length > 512 || keys.auth.length > 512) return null
  return { endpoint: item.endpoint, expirationTime: typeof item.expirationTime === 'number' ? item.expirationTime : null, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}
function newStore(): NotificationStore {
  const keys = webPush.generateVAPIDKeys()
  return { version: STORE_VERSION, vapid: { subject: process.env.TMUXGO_WEB_PUSH_SUBJECT?.trim() || 'mailto:admin@tmuxgo.local', ...keys }, subscriptions: [], notifications: [] }
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
  const pending = savePromise.then(() => writeStore(value, targetPath), () => writeStore(value, targetPath))
  savePromise = pending.then(() => undefined, () => undefined)
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
      if (parsed.version === STORE_VERSION && parsed.vapid && typeof parsed.vapid.publicKey === 'string' && typeof parsed.vapid.privateKey === 'string' && Array.isArray(parsed.subscriptions) && Array.isArray(parsed.notifications)) loaded = parsed as NotificationStore
    } catch {}
    store = loaded || newStore()
    loadedStorePath = currentPath
    store.subscriptions = store.subscriptions.filter((item) => normalizeSubscription(item) !== null && typeof item.id === 'string' && typeof item.deviceId === 'string').map((item) => ({ ...item, ...normalizeSubscription(item)! }))
    store.notifications = store.notifications.filter((item) => item && typeof item.id === 'string' && typeof item.eventId === 'string' && typeof item.hostId === 'string' && typeof item.sessionName === 'string' && typeof item.paneId === 'string' && Array.isArray(item.readBy)).slice(0, 500)
    await saveStore(store)
    return store
  })().finally(() => { storePromise = null })
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
function publicMessage(status: AgentNotificationRecord['status'], agent: string) {
  const messages: Record<AgentNotificationRecord['status'], string> = { blocked: `${agent} is waiting for attention`, done: `${agent} completed a turn`, permission_required: `${agent} is waiting for permission`, needs_input: `${agent} is waiting for input`, failed: `${agent} reported a failure`, ended: `${agent} ended`, disconnected: `${agent} disconnected` }
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
  const payload = JSON.stringify({ type: 'agent_notification', id: notification.id, hostId: notification.hostId, sessionName: notification.sessionName, paneId: notification.paneId, agent: notification.agent, status: notification.status, message: notification.message, timestamp: notification.timestamp, url: `/?hostId=${encodeURIComponent(notification.hostId)}&sessionName=${encodeURIComponent(notification.sessionName)}&paneId=${encodeURIComponent(notification.paneId)}&notificationId=${encodeURIComponent(notification.id)}` })
  const removed = new Set<string>()
  await Promise.all(value.subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification(subscription, payload)
    } catch (error) {
      const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : 0
      if (statusCode === 404 || statusCode === 410) removed.add(subscription.id)
    }
  }))
  if (removed.size) {
    value.subscriptions = value.subscriptions.filter((subscription) => !removed.has(subscription.id))
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
  const next: StoredSubscription = { ...subscription, id, deviceId, createdAt: previous?.createdAt || now, updatedAt: now }
  value.subscriptions = [...value.subscriptions.filter((item) => item.id !== id), next]
  await saveStore(value)
  return { id, deviceId, endpoint: subscription.endpoint, updatedAt: now }
}
export async function revokeAgentPushSubscription(id: string, deviceId?: string) {
  const value = await loadStore()
  const before = value.subscriptions.length
  value.subscriptions = value.subscriptions.filter((item) => !(item.id === id && (!deviceId || item.deviceId === deviceId)))
  if (value.subscriptions.length !== before) await saveStore(value)
  return value.subscriptions.length !== before
}
export async function listUnreadAgentNotifications(deviceId: string, limit = 100) {
  deviceId = normalizeAgentDeviceId(deviceId)
  const value = await loadStore()
  return value.notifications.filter((item) => !item.readBy.includes(deviceId)).slice(0, Math.max(1, Math.min(200, limit)))
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
  const notification: AgentNotificationRecord = { id: event.eventId, eventId: event.eventId, hostId: event.hostId, sessionName: event.sessionName, paneId: event.pane.paneId, agent: event.pane.agent, status, message: publicMessage(status, event.pane.agent), timestamp, readBy: [] }
  value.notifications = [notification, ...value.notifications].slice(0, 500)
  await saveStore(value)
  await sendPush(value, notification)
  return notification
}
