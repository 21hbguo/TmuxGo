import { useState, useEffect, useCallback } from 'react'

export type Language = 'zh' | 'en'

export interface Preferences {
  theme: 'dark' | 'light' | 'high-contrast'
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  sidebarPosition: 'left' | 'right'
  showStatusBar: boolean
  showQuickActions: boolean
  autoReconnect: boolean
  reconnectInterval: number
  terminalPadding: number
  language: Language
  attachExclusive: boolean
}

const defaultPreferences: Preferences = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'JetBrains Mono, monospace',
  cursorBlink: true,
  sidebarPosition: 'left',
  showStatusBar: true,
  showQuickActions: true,
  autoReconnect: true,
  reconnectInterval: 3000,
  terminalPadding: 8,
  language: 'zh',
  attachExclusive: false,
}

let preferencesStore:Preferences=defaultPreferences
const listeners=new Set<(preferences:Preferences)=>void>()

function readStoredPreferences() {
  if (typeof window === 'undefined') {
    return defaultPreferences
  }
  const stored = localStorage.getItem('tmuxu-preferences')
  if (!stored) {
    return defaultPreferences
  }
  try {
    return { ...defaultPreferences, ...JSON.parse(stored) }
  } catch (err) {
    console.error('Failed to parse preferences:', err)
    return defaultPreferences
  }
}

function emitPreferences(next: Preferences) {
  preferencesStore = next
  listeners.forEach((listener) => listener(next))
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(preferencesStore)

  useEffect(() => {
    const initial = readStoredPreferences()
    emitPreferences(initial)
    setPreferences(initial)
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== 'tmuxu-preferences') return
      const next = readStoredPreferences()
      emitPreferences(next)
      setPreferences(next)
    }
    listeners.add(setPreferences)
    window.addEventListener('storage', handleStorage)
    return () => {
      listeners.delete(setPreferences)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', preferences.theme)
  }, [preferences.theme])

  const updatePreferences = useCallback((updates: Partial<Preferences>) => {
    const updated = { ...preferencesStore, ...updates }
    localStorage.setItem('tmuxu-preferences', JSON.stringify(updated))
    emitPreferences(updated)
  }, [])

  const resetPreferences = useCallback(() => {
    localStorage.setItem('tmuxu-preferences', JSON.stringify(defaultPreferences))
    emitPreferences(defaultPreferences)
  }, [])

  return { preferences, updatePreferences, resetPreferences }
}
