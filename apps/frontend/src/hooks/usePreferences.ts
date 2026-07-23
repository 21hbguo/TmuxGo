import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { UiPreferences } from '@/types'

export type Language = 'zh' | 'en'
export type AppFontId = 'jetbrains' | 'maple'
export const PREFERENCES_VERSION = 3
const STORAGE_KEY = 'tmuxgo-preferences'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-preferences-updated-at'
const PROFILE = 'default'
type StoredPreferences = Partial<Preferences> & { _v?: number }

export const FONT_JETBRAINS = '"JetBrains Mono", monospace'
export const FONT_MAPLE = '"Maple Mono", monospace'
export const ALLOWED_FONT_FAMILIES = [FONT_JETBRAINS, FONT_MAPLE] as const

const FONT_UI: Record<AppFontId, string> = {
  jetbrains: '"JetBrains Mono", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
  maple: '"Maple Mono", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
}
const FONT_MONO: Record<AppFontId, string> = {
  jetbrains: '"JetBrains Mono", monospace',
  maple: '"Maple Mono", monospace',
}

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
  fontFamily: FONT_JETBRAINS,
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

export function resolveFontId(fontFamily?: string): AppFontId {
  if (!fontFamily) return 'jetbrains'
  if (fontFamily === FONT_MAPLE || fontFamily === 'maple') return 'maple'
  if (fontFamily === FONT_JETBRAINS || fontFamily === 'jetbrains') return 'jetbrains'
  if (fontFamily.includes('Maple Mono') || /(^|[\s,"'])maple([\s,"']|$)/i.test(fontFamily)) return 'maple'
  return 'jetbrains'
}

export function normalizeFontFamily(fontFamily?: string) {
  return resolveFontId(fontFamily) === 'maple' ? FONT_MAPLE : FONT_JETBRAINS
}

export function primaryFontName(fontFamily?: string) {
  return resolveFontId(fontFamily) === 'maple' ? 'Maple Mono' : 'JetBrains Mono'
}

export async function ensureAppFontLoaded(fontFamily?: string, size = 14) {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  const name = primaryFontName(fontFamily)
  try {
    await Promise.all([
      document.fonts.load(`400 ${size}px "${name}"`),
      document.fonts.load(`700 ${size}px "${name}"`),
    ])
    await document.fonts.ready
  } catch {}
}

export function applyDocumentFont(fontFamily?: string) {
  if (typeof document === 'undefined') return
  const id = resolveFontId(fontFamily)
  const root = document.documentElement
  const ui = FONT_UI[id]
  const mono = FONT_MONO[id]
  root.setAttribute('data-font', id)
  root.style.setProperty('--font-ui', ui)
  root.style.setProperty('--font-mono', mono)
  root.style.fontFamily = ui
  if (document.body) {
    document.body.style.fontFamily = ui
    document.body.style.fontSynthesis = 'none'
  }
  const app = document.getElementById('root')
  if (app) app.style.fontFamily = ui
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
    const normalizedFont = normalizeFontFamily(next.fontFamily)
    const fontForced = next.fontFamily !== normalizedFont
    if (fontForced) {
      next.fontFamily = normalizedFont
    }
    if (version !== PREFERENCES_VERSION || fontForced) {
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
    applyDocumentFont(initial.fontFamily)
    void ensureAppFontLoaded(initial.fontFamily, initial.fontSize)
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return
      const next = readStoredPreferences()
      emitPreferences(next)
      setPreferences(next)
      applyDocumentFont(next.fontFamily)
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
              const merged = { ...defaultPreferences, ...remoteUi, fontFamily: normalizeFontFamily(remoteUi.fontFamily) } as Preferences
              localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...merged, _v: PREFERENCES_VERSION }))
              localStorage.setItem(STORAGE_UPDATED_AT_KEY, remoteUpdatedAt || new Date().toISOString())
              emitPreferences(merged)
              setPreferences(merged)
              applyDocumentFont(merged.fontFamily)
              void ensureAppFontLoaded(merged.fontFamily, merged.fontSize)
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
    applyDocumentFont(preferences.fontFamily)
    void ensureAppFontLoaded(preferences.fontFamily, preferences.fontSize)
    const themeColor = document.querySelector('meta[name="theme-color"]')
    if (themeColor) themeColor.setAttribute('content', `rgb(${getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim()})`)
    const statusBarStyle = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    if (statusBarStyle) statusBarStyle.setAttribute('content', preferences.theme === 'light' ? 'default' : 'black-translucent')
  }, [preferences.theme, preferences.fontFamily, preferences.fontSize])

  const updatePreferences = useCallback((updates: Partial<Preferences>) => {
    const nextUpdates = { ...updates }
    if (nextUpdates.fontFamily !== undefined) {
      nextUpdates.fontFamily = normalizeFontFamily(nextUpdates.fontFamily)
    }
    const updated = { ...preferencesStore, ...nextUpdates }
    const now = new Date().toISOString()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...updated, _v: PREFERENCES_VERSION }))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, now)
    applyDocumentFont(updated.fontFamily)
    void ensureAppFontLoaded(updated.fontFamily, updated.fontSize)
    emitPreferences(updated)
    void api.preferences.update({ uiPreferences: toUiPreferences(updated), uiPreferencesUpdatedAt: now }, PROFILE).catch(() => {})
  }, [])

  const resetPreferences = useCallback(() => {
    const now = new Date().toISOString()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaultPreferences, _v: PREFERENCES_VERSION }))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, now)
    applyDocumentFont(defaultPreferences.fontFamily)
    emitPreferences(defaultPreferences)
    void api.preferences.update({ uiPreferences: toUiPreferences(defaultPreferences), uiPreferencesUpdatedAt: now }, PROFILE).catch(() => {})
  }, [])

  return { preferences, updatePreferences, resetPreferences, isReady }
}
