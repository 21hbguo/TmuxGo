import type { FileEditorDocument } from '@/types'

type PersistedEditor = Pick<FileEditorDocument, 'id' | 'hostId' | 'rootId' | 'rootLabel' | 'rootPath' | 'path' | 'name' | 'absolutePath' | 'language'>
const OPEN_EDITORS_STORAGE_KEY = 'tmuxgo-open-editors'
const ACTIVE_EDITOR_STORAGE_KEY = 'tmuxgo-active-editor'
const ACTIVE_HOST_STORAGE_KEY = 'tmuxgo-active-host'
const ACTIVE_SESSION_STORAGE_KEY = 'tmuxgo-active-session'

export function getActiveSessionStorageKey(hostId: string) {
  return `${ACTIVE_SESSION_STORAGE_KEY}:${hostId}`
}
export function readPersistedEditors() {
  if (typeof window === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(OPEN_EDITORS_STORAGE_KEY) || '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter((item): item is PersistedEditor => !!item && typeof item.id === 'string' && typeof item.hostId === 'string' && typeof item.rootId === 'string' && typeof item.rootLabel === 'string' && typeof item.rootPath === 'string' && typeof item.path === 'string' && typeof item.name === 'string' && typeof item.absolutePath === 'string' && typeof item.language === 'string')
  } catch {
    return []
  }
}
export function readPersistedActiveEditorId() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ACTIVE_EDITOR_STORAGE_KEY) || null
}
export function writePersistedEditors(openEditors: FileEditorDocument[], activeEditorId: string | null) {
  if (typeof window === 'undefined') return
  const nextEditors = openEditors.filter((item) => !item.kind || item.kind === 'file').map(({ id, hostId, rootId, rootLabel, rootPath, path, name, absolutePath, language }) => ({ id, hostId, rootId, rootLabel, rootPath, path, name, absolutePath, language }))
  localStorage.setItem(OPEN_EDITORS_STORAGE_KEY, JSON.stringify(nextEditors))
  if (activeEditorId) localStorage.setItem(ACTIVE_EDITOR_STORAGE_KEY, activeEditorId)
  else localStorage.removeItem(ACTIVE_EDITOR_STORAGE_KEY)
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
  return localStorage.getItem(getActiveSessionStorageKey(hostId)) || localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || ''
}
export function writeActiveSessionId(hostId: string | null, id: string) {
  if (typeof window === 'undefined') return
  if (id) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id)
  else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
  if (!hostId) return
  if (id) localStorage.setItem(getActiveSessionStorageKey(hostId), id)
  else localStorage.removeItem(getActiveSessionStorageKey(hostId))
}
