import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { UiPreferences } from '@/types'

export type Language = 'zh' | 'en'
const PREFERENCES_VERSION = 2
const STORAGE_KEY = 'tmuxgo-preferences'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-preferences-updated-at'
const PROFILE = 'default'
type StoredPreferences = Partial<Preferences> & { _v?: number }

export interface Preferences {
  theme: 'dark' | 'light' | 'high-contrast' | 'dracula' | 'nord' | 'catppuccin'
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  sidebarPosition: 'left' | 'right'
  showStatusBar: boolean
  showQuickActions: boolean
  agentNotificationsEnabled: boolean
  agentNotificationDurationMs: number
  autoReconnect: boolean
  reconnectInterval: number
  terminalPadding: number
  language: Language
  attachExclusive: boolean
  uploadRateLimitKBps: number
  downloadRateLimitKBps: number
}

const defaultPreferences: Preferences = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'Consolas, "Cascadia Mono", "Cascadia Code", "SF Mono", Monaco, Menlo, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace',
  cursorBlink: true,
  sidebarPosition: 'left',
  showStatusBar: true,
  showQuickActions: true,
  agentNotificationsEnabled: true,
  agentNotificationDurationMs: 10000,
  autoReconnect: true,
  reconnectInterval: 3000,
  terminalPadding: 0,
  language: 'zh',
  attachExclusive: true,
  uploadRateLimitKBps: 200,
  downloadRateLimitKBps: 200,
}

let preferencesStore: Preferences = defaultPreferences
const listeners = new Set<(preferences: Preferences) => void>()
const readyListeners = new Set<(ready: boolean) => void>()
let syncedWithServer = false
let preferencesReady = false

function toUiPreferences(p: Preferences): UiPreferences {
  return {
    theme: p.theme,
    fontSize: p.fontSize,
    fontFamily: p.fontFamily,
    cursorBlink: p.cursorBlink,
    sidebarPosition: p.sidebarPosition,
    showStatusBar: p.showStatusBar,
    showQuickActions: p.showQuickActions,
    agentNotificationsEnabled: p.agentNotificationsEnabled,
    agentNotificationDurationMs: p.agentNotificationDurationMs,
    autoReconnect: p.autoReconnect,
    reconnectInterval: p.reconnectInterval,
    terminalPadding: p.terminalPadding,
    language: p.language,
    attachExclusive: p.attachExclusive,
  }
}

function readStoredPreferences() {
  if (typeof window === 'undefined') {
    return defaultPreferences
  }
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) {
    return defaultPreferences
  }
  try {
    const parsed = JSON.parse(stored) as StoredPreferences
    const version = typeof parsed?._v === 'number' ? parsed._v : 1
    const next = { ...defaultPreferences, ...parsed }
    if (version < PREFERENCES_VERSION && parsed.terminalPadding === 8) {
      next.terminalPadding = 0
    }
    if (version !== PREFERENCES_VERSION) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, _v: PREFERENCES_VERSION }))
    }
    return next
  } catch (err) {
    console.error('Failed to parse preferences:', err)
    return defaultPreferences
  }
}

function emitPreferences(next: Preferences) {
  preferencesStore = next
  listeners.forEach((listener) => listener(next))
}
function markPreferencesReady() {
  if (preferencesReady) return
  preferencesReady = true
  readyListeners.forEach((listener) => listener(true))
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(preferencesStore)
  const [isReady, setIsReady] = useState(preferencesReady)

  useEffect(() => {
    const hasStoredPreferences = localStorage.getItem(STORAGE_KEY) !== null
    const initial = readStoredPreferences()
    emitPreferences(initial)
    setPreferences(initial)
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return
      const next = readStoredPreferences()
      emitPreferences(next)
      setPreferences(next)
    }
    listeners.add(setPreferences)
    readyListeners.add(setIsReady)
    window.addEventListener('storage', handleStorage)
    if (hasStoredPreferences) markPreferencesReady()
    if (preferencesReady) setIsReady(true)

    if (!syncedWithServer) {
      syncedWithServer = true
      void (async () => {
        try {
          const remote = await api.preferences.get(PROFILE)
          const remoteUi = remote.uiPreferences
          const remoteUpdatedAt = remote.uiPreferencesUpdatedAt || ''
          const localUpdatedAt = localStorage.getItem(STORAGE_UPDATED_AT_KEY) || ''
          const localMs = Date.parse(localUpdatedAt)
          const remoteMs = Date.parse(remoteUpdatedAt)
          if (remoteUi && Object.keys(remoteUi).length > 0) {
            if (!Number.isNaN(remoteMs) && (Number.isNaN(localMs) || remoteMs >= localMs)) {
              const merged = { ...defaultPreferences, ...remoteUi } as Preferences
              localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...merged, _v: PREFERENCES_VERSION }))
              localStorage.setItem(STORAGE_UPDATED_AT_KEY, remoteUpdatedAt || new Date().toISOString())
              emitPreferences(merged)
              setPreferences(merged)
              return
            }
            if (!Number.isNaN(localMs) && (Number.isNaN(remoteMs) || localMs > remoteMs)) {
              const current = readStoredPreferences()
              await api.preferences.update({ uiPreferences: toUiPreferences(current), uiPreferencesUpdatedAt: localUpdatedAt }, PROFILE)
            }
          } else {
            const current = readStoredPreferences()
            const now = new Date().toISOString()
            await api.preferences.update({ uiPreferences: toUiPreferences(current), uiPreferencesUpdatedAt: now }, PROFILE)
            localStorage.setItem(STORAGE_UPDATED_AT_KEY, now)
          }
        } catch {} finally {
          markPreferencesReady()
        }
      })()
    }

    return () => {
      listeners.delete(setPreferences)
      readyListeners.delete(setIsReady)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', preferences.theme)
    const themeColor = document.querySelector('meta[name="theme-color"]')
    if (themeColor) themeColor.setAttribute('content', `rgb(${getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim()})`)
    const statusBarStyle = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    if (statusBarStyle) statusBarStyle.setAttribute('content', preferences.theme === 'light' ? 'default' : 'black-translucent')
  }, [preferences.theme])

  const updatePreferences = useCallback((updates: Partial<Preferences>) => {
    const updated = { ...preferencesStore, ...updates }
    const now = new Date().toISOString()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...updated, _v: PREFERENCES_VERSION }))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, now)
    emitPreferences(updated)
    void api.preferences.update({ uiPreferences: toUiPreferences(updated), uiPreferencesUpdatedAt: now }, PROFILE).catch(() => {})
  }, [])

  const resetPreferences = useCallback(() => {
    const now = new Date().toISOString()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaultPreferences, _v: PREFERENCES_VERSION }))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, now)
    emitPreferences(defaultPreferences)
    void api.preferences.update({ uiPreferences: toUiPreferences(defaultPreferences), uiPreferencesUpdatedAt: now }, PROFILE).catch(() => {})
  }, [])

  return { preferences, updatePreferences, resetPreferences, isReady }
}
