import { api, type AgentNotificationRecord } from './api'

const deviceIdKey = 'tmuxgo-agent-device-id'
function getDeviceId() {
  if (typeof window === 'undefined') return ''
  try {
    const stored = window.localStorage.getItem(deviceIdKey)
    if (stored && /^[A-Za-z0-9._:-]{1,128}$/.test(stored)) return stored
  } catch {}
  const generated = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try { window.localStorage.setItem(deviceIdKey, generated) } catch {}
  return generated
}
function canUsePush() {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'
}
function decodeVapidKey(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const raw = window.atob(padded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}
async function serviceWorkerRegistration() {
  if (!canUsePush()) return null
  return navigator.serviceWorker.register('/sw.js')
}
async function subscribePush() {
  const serviceWorker = await serviceWorkerRegistration()
  if (!serviceWorker || !api.agentNotifications?.vapidPublicKey || !api.agentNotifications.subscribe) return null
  if (Notification.permission !== 'granted') return null
  let subscription = await serviceWorker.pushManager.getSubscription()
  if (!subscription) {
    const { publicKey } = await api.agentNotifications.vapidPublicKey()
    subscription = await serviceWorker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(publicKey) })
  }
  const deviceId = getDeviceId()
  if (!deviceId) return null
  const saved = await api.agentNotifications.subscribe(deviceId, subscription.toJSON())
  return { deviceId, subscriptionId: saved.id }
}
export async function syncAgentPush() {
  if (!api.agentNotifications?.unread) return [] as AgentNotificationRecord[]
  try {
    const deviceId = getDeviceId()
    if (!deviceId) return []
    await subscribePush().catch(() => null)
    const result = await api.agentNotifications.unread(deviceId)
    return Array.isArray(result.notifications) ? result.notifications : []
  } catch {
    return []
  }
}
export async function markAgentNotificationsRead(ids: string[] = []) {
  if (!api.agentNotifications?.read) return
  const deviceId = getDeviceId()
  if (!deviceId) return
  await api.agentNotifications.read(deviceId, ids).catch(() => null)
}
export async function enableAgentPush() {
  if (!api.agentNotifications?.subscribe) return false
  try {
    return !!await subscribePush()
  } catch {
    return false
  }
}
