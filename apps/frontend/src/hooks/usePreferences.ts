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
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences)

  useEffect(() => {
    const stored = localStorage.getItem('tmuxu-preferences')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        setPreferences({ ...defaultPreferences, ...parsed })
      } catch (err) {
        console.error('Failed to parse preferences:', err)
      }
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', preferences.theme)
  }, [preferences.theme])

  const updatePreferences = useCallback((updates: Partial<Preferences>) => {
    setPreferences((prev) => {
      const updated = { ...prev, ...updates }
      localStorage.setItem('tmuxu-preferences', JSON.stringify(updated))
      return updated
    })
  }, [])

  const resetPreferences = useCallback(() => {
    setPreferences(defaultPreferences)
    localStorage.setItem('tmuxu-preferences', JSON.stringify(defaultPreferences))
  }, [])

  return { preferences, updatePreferences, resetPreferences }
}
