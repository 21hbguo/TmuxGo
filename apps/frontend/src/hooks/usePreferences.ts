import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { UiPreferences } from '@/types'

export type Language = 'zh' | 'en'
export type AppFontId = 'jetbrains'
export const PREFERENCES_VERSION = 4
const STORAGE_KEY = 'tmuxgo-preferences'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-preferences-updated-at'
const PROFILE = 'default'
type StoredPreferences = Partial<Preferences> & { _v?: number }

// 与 VSCode 对齐：JetBrains Mono 拉丁 + 系统 CJK 回退
export const FONT_JETBRAINS = '"JetBrains Mono", "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei", monospace'
export const ALLOWED_FONT_FAMILIES = [FONT_JETBRAINS] as const
export interface Preferences {
  theme: 'dark' | 'light' | 'high-contrast' | 'dracula' | 'nord' | 'catppuccin' | 'sage'
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  sidebarPosition: 'left' | 'right'
  showStatusBar: boolean
  showQuickActions: boolean
  immersiveFullscreen: boolean
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
  immersiveFullscreen: false,
  agentNotificationsEnabled: true,
  agentNotificationDurationMs: 10000,
  autoReconnect: true,
  reconnectInterval: 3000,
  terminalPadding: 0,
  language: 'zh',
  attachExclusive: true,
  uploadRateLimitKBps: 5120,
  downloadRateLimitKBps: 5120,
}

export function resolveFontId(_fontFamily?: string): AppFontId {
  return 'jetbrains'
}

export function normalizeFontFamily(_fontFamily?: string) {
  return FONT_JETBRAINS
}

export function primaryFontName(_fontFamily?: string) {
  return 'JetBrains Mono'
}

let regularFontLoadPromise: Promise<void> | null = null

export async function ensureAppFontLoaded(fontFamily?: string, size = 14) {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  const name = primaryFontName(fontFamily)
  if (!regularFontLoadPromise) {
    regularFontLoadPromise = (async () => {
      try {
        await document.fonts.load(`400 ${size}px "${name}"`)
      } catch {}
      void document.fonts.load(`700 ${size}px "${name}"`).catch(() => {})
    })()
  }
  await regularFontLoadPromise
}

export function applyDocumentFont(_fontFamily?: string) {
  if (typeof document === 'undefined') return
  // 不再 inline --font-ui/--font-mono/fontFamily：否则会盖住 [data-theme] 的 --font-ui 覆盖（如 sage 主题）
  document.documentElement.setAttribute('data-font', 'jetbrains')
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

function readThemeBgHex() {
  const rawBg = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim()
  const rgb = rawBg.split(/\s+/).map((part) => Number(part))
  if (rgb.length >= 3 && rgb.slice(0, 3).every((n) => Number.isFinite(n))) {
    return `#${rgb
      .slice(0, 3)
      .map((n) =>
        Math.max(0, Math.min(255, Math.round(n)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`
  }
  return '#0c0d0f'
}

function applyThemeChrome(theme: Preferences['theme']) {
  const isLight = theme === 'light'
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.colorScheme = isLight ? 'light' : 'dark'
  const themeHex = readThemeBgHex()
  document.documentElement.style.backgroundColor = themeHex
  document.body.style.backgroundColor = themeHex
  let themeColor = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null
  if (!themeColor) {
    themeColor = document.createElement('meta')
    themeColor.setAttribute('name', 'theme-color')
    document.head.appendChild(themeColor)
  }
  themeColor.setAttribute('content', themeHex)
  themeColor.parentElement?.appendChild(themeColor)
  const statusBarStyle = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
  if (statusBarStyle) statusBarStyle.setAttribute('content', isLight ? 'default' : 'black-translucent')
  return themeHex
}

const MOBILE_BROWSER_UA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i

export function isMobileBrowser() {
  return typeof navigator !== 'undefined' && MOBILE_BROWSER_UA.test(navigator.userAgent)
}

export function getFullscreenElement() {
  return document.fullscreenElement || (document as any).webkitFullscreenElement || null
}

async function requestAppFullscreen() {
  const el = document.documentElement as any
  if (el.requestFullscreen) return el.requestFullscreen({ navigationUI: 'hide' })
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen()
  throw new Error('fullscreen-unsupported')
}

async function exitAppFullscreen() {
  const doc = document as any
  if (document.exitFullscreen && getFullscreenElement()) return document.exitFullscreen()
  if (doc.webkitExitFullscreen && getFullscreenElement()) return doc.webkitExitFullscreen()
}

function persistImmersivePreference(active: boolean) {
  if (preferencesStore.immersiveFullscreen === active) return preferencesStore
  const updated = { ...preferencesStore, immersiveFullscreen: active }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...updated, _v: PREFERENCES_VERSION }))
  emitPreferences(updated)
  return updated
}

export function applyImmersivePresentation(active: boolean) {
  document.documentElement.toggleAttribute('data-immersive-fullscreen', active)
  applyThemeChrome(preferencesStore.theme)
  if (active) {
    const height = Math.round(
      window.visualViewport?.height || window.innerHeight || (typeof screen !== 'undefined' ? screen.height : 0) || 0,
    )
    document.documentElement.style.setProperty('--immersive-vh', `${height}px`)
  } else {
    document.documentElement.style.removeProperty('--immersive-vh')
  }
  window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'immersive-fullscreen', active } }))
}

export async function setImmersiveFullscreenMode(active: boolean) {
  persistImmersivePreference(active)
  applyImmersivePresentation(active)
  if (active) {
    try {
      await requestAppFullscreen()
    } catch {}
  } else if (getFullscreenElement()) {
    try {
      await exitAppFullscreen()
    } catch {}
  }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(preferencesStore)
  const [isReady, setIsReady] = useState(preferencesReady)

  useEffect(() => {
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
    markPreferencesReady()
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
              const merged = {
                ...defaultPreferences,
                ...remoteUi,
                fontFamily: normalizeFontFamily(remoteUi.fontFamily),
              } as Preferences
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
              await api.preferences.update(
                { uiPreferences: toUiPreferences(current), uiPreferencesUpdatedAt: localUpdatedAt },
                PROFILE,
              )
            }
          } else {
            const current = readStoredPreferences()
            const now = new Date().toISOString()
            await api.preferences.update(
              { uiPreferences: toUiPreferences(current), uiPreferencesUpdatedAt: now },
              PROFILE,
            )
            localStorage.setItem(STORAGE_UPDATED_AT_KEY, now)
          }
        } catch {
        } finally {
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
    applyThemeChrome(preferences.theme)
    applyDocumentFont(preferences.fontFamily)
    void ensureAppFontLoaded(preferences.fontFamily, preferences.fontSize)
    if (preferences.immersiveFullscreen) applyImmersivePresentation(true)
  }, [preferences.theme, preferences.fontFamily, preferences.fontSize, preferences.immersiveFullscreen])

  useEffect(() => {
    applyImmersivePresentation(preferencesStore.immersiveFullscreen)
    const syncFs = () => {
      const fs = !!getFullscreenElement()
      const want = preferencesStore.immersiveFullscreen
      if (!fs && want) {
        persistImmersivePreference(false)
        applyImmersivePresentation(false)
        return
      }
      applyImmersivePresentation(want || fs)
    }
    const onResize = () => {
      if (preferencesStore.immersiveFullscreen) applyImmersivePresentation(true)
    }
    document.addEventListener('fullscreenchange', syncFs)
    document.addEventListener('webkitfullscreenchange', syncFs as any)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('fullscreenchange', syncFs)
      document.removeEventListener('webkitfullscreenchange', syncFs as any)
      window.removeEventListener('resize', onResize)
    }
  }, [])

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
    void api.preferences
      .update({ uiPreferences: toUiPreferences(updated), uiPreferencesUpdatedAt: now }, PROFILE)
      .catch(() => {})
  }, [])

  const resetPreferences = useCallback(() => {
    const now = new Date().toISOString()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaultPreferences, _v: PREFERENCES_VERSION }))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, now)
    applyDocumentFont(defaultPreferences.fontFamily)
    emitPreferences(defaultPreferences)
    applyImmersivePresentation(false)
    void exitAppFullscreen().catch(() => {})
    void api.preferences
      .update({ uiPreferences: toUiPreferences(defaultPreferences), uiPreferencesUpdatedAt: now }, PROFILE)
      .catch(() => {})
  }, [])

  return { preferences, updatePreferences, resetPreferences, isReady }
}
