import type { FileEditorDocument } from '@/types'

const OPEN_EDITORS_STORAGE_KEY = 'tmuxgo-open-editors'
const ACTIVE_EDITOR_STORAGE_KEY = 'tmuxgo-active-editor'
const ACTIVE_HOST_STORAGE_KEY = 'tmuxgo-active-host'
const ACTIVE_SESSION_STORAGE_KEY = 'tmuxgo-active-session'
const CONSOLE_STATE_STORAGE_KEY_PREFIX = 'tmuxgo-console-state'

const MOBILE_BROWSER_UA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i

export type DeviceKind = 'mobile' | 'desktop'

export function detectDeviceKind(): DeviceKind {
  if (typeof navigator === 'undefined') return 'desktop'
  return MOBILE_BROWSER_UA.test(navigator.userAgent) ? 'mobile' : 'desktop'
}

export function getConsoleStateStorageKey(device: DeviceKind = detectDeviceKind()): string {
  return `${CONSOLE_STATE_STORAGE_KEY_PREFIX}:${device}`
}

export type PersistedEditorMeta = Pick<
  FileEditorDocument,
  | 'id'
  | 'hostId'
  | 'rootId'
  | 'rootLabel'
  | 'rootPath'
  | 'path'
  | 'name'
  | 'absolutePath'
  | 'language'
  | 'kind'
  | 'preview'
  | 'compareLeftId'
  | 'compareRightId'
>

export function getActiveSessionStorageKey(hostId: string) {
  return `${ACTIVE_SESSION_STORAGE_KEY}:${hostId}`
}
export function readActiveHostId() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ACTIVE_HOST_STORAGE_KEY) || null
}
export function writeActiveHostId(id: string) {
  if (typeof window === 'undefined') return
  localStorage.setItem(ACTIVE_HOST_STORAGE_KEY, id)
}
export function readActiveSessionId(hostId: string) {
  if (typeof window === 'undefined') return ''
  return (
    localStorage.getItem(getActiveSessionStorageKey(hostId)) || localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || ''
  )
}
export function writeActiveSessionId(hostId: string | null, id: string) {
  if (typeof window === 'undefined') return
  if (id) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id)
  else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
  if (!hostId) return
  if (id) localStorage.setItem(getActiveSessionStorageKey(hostId), id)
  else localStorage.removeItem(getActiveSessionStorageKey(hostId))
}
export function readLegacyConsoleState(): {
  openEditors: PersistedEditorMeta[]
  activeEditorId: string | null
  activeHostId: string | null
} | null {
  if (typeof window === 'undefined') return null
  try {
    const rawEditors = JSON.parse(localStorage.getItem(OPEN_EDITORS_STORAGE_KEY) || '[]')
    const activeEditorId = localStorage.getItem(ACTIVE_EDITOR_STORAGE_KEY) || null
    const activeHostId = localStorage.getItem(ACTIVE_HOST_STORAGE_KEY) || null
    if (!Array.isArray(rawEditors) || (rawEditors.length === 0 && !activeEditorId && !activeHostId)) return null
    const openEditors = (rawEditors as unknown[])
      .filter(
        (item): item is PersistedEditorMeta =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).id === 'string' &&
          typeof (item as Record<string, unknown>).hostId === 'string' &&
          typeof (item as Record<string, unknown>).rootId === 'string' &&
          typeof (item as Record<string, unknown>).rootLabel === 'string' &&
          typeof (item as Record<string, unknown>).rootPath === 'string' &&
          typeof (item as Record<string, unknown>).path === 'string' &&
          typeof (item as Record<string, unknown>).name === 'string' &&
          typeof (item as Record<string, unknown>).absolutePath === 'string' &&
          typeof (item as Record<string, unknown>).language === 'string',
      )
      .map((item): PersistedEditorMeta => ({ ...item, kind: item.kind === 'compare' ? 'compare' : 'file' }))
    return { openEditors, activeEditorId, activeHostId }
  } catch {
    return null
  }
}
export function clearLegacyEditorStorage() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(OPEN_EDITORS_STORAGE_KEY)
  localStorage.removeItem(ACTIVE_EDITOR_STORAGE_KEY)
}
