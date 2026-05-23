'use client'

import { useState, useEffect, useCallback } from 'react'

export interface CustomShortcut {
  id: string
  label: string
  keys: string
}

const STORAGE_KEY = 'tmuxu-custom-shortcuts'

const KEY_MAP: Record<string, string> = {
  'enter': '\r',
  'tab': '\t',
  'esc': '\x1b',
  'escape': '\x1b',
  'backspace': '\x7f',
  'delete': '\x1b[3~',
  'up': '\x1b[A',
  'down': '\x1b[B',
  'right': '\x1b[C',
  'left': '\x1b[D',
  'home': '\x1b[H',
  'end': '\x1b[F',
  'insert': '\x1b[2~',
  'pageup': '\x1b[5~',
  'pagedown': '\x1b[6~',
  'f1': '\x1bOP',
  'f2': '\x1bOQ',
  'f3': '\x1bOR',
  'f4': '\x1bOS',
  'f5': '\x1b[15~',
  'f6': '\x1b[17~',
  'f7': '\x1b[18~',
  'f8': '\x1b[19~',
  'f9': '\x1b[20~',
  'f10': '\x1b[21~',
  'f11': '\x1b[23~',
  'f12': '\x1b[24~',
}

export function keysToEscape(keys: string): string {
  const parts = keys.split('+').map((s) => s.trim().toLowerCase())
  const hasCtrl = parts.includes('ctrl')
  const hasShift = parts.includes('shift')
  const hasAlt = parts.includes('alt')
  const hasMeta = parts.includes('meta') || parts.includes('cmd')
  const key = parts.find((p) => !['ctrl', 'shift', 'alt', 'meta', 'cmd'].includes(p)) || ''

  if (!key) return ''

  const special = KEY_MAP[key]
  if (special) {
    if (key === 'tab' && hasShift) return '\x1b[Z'
    return special
  }

  if (key.length === 1) {
    let code = key.charCodeAt(0)
    if (hasCtrl) {
      const upper = key.toUpperCase()
      const c = upper.charCodeAt(0)
      if (c >= 65 && c <= 90) return String.fromCharCode(c - 64)
      return ''
    }
    if (hasShift) return key.toUpperCase()
    return key
  }

  return ''
}

export function formatKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  const skip = ['Control', 'Alt', 'Shift', 'Meta']
  const key = skip.includes(e.key) ? '' : e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (key) parts.push(key)
  return parts.join('+')
}

export function useCustomShortcuts() {
  const [shortcuts, setShortcuts] = useState<CustomShortcut[]>([])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setShortcuts(JSON.parse(raw))
    } catch {}
  }, [])

  const persist = useCallback((next: CustomShortcut[]) => {
    setShortcuts(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }, [])

  const addShortcut = useCallback((s: Omit<CustomShortcut, 'id'>) => {
    persist([...shortcuts, { ...s, id: Date.now().toString(36) + Math.random().toString(36).slice(2) }])
  }, [shortcuts, persist])

  const removeShortcut = useCallback((id: string) => {
    persist(shortcuts.filter((s) => s.id !== id))
  }, [shortcuts, persist])

  return { shortcuts, addShortcut, removeShortcut }
}
