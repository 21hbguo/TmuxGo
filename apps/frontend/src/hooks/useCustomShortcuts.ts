'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { CustomShortcut } from '@/types'
export type { CustomShortcut } from '@/types'

const STORAGE_KEY = 'tmuxgo-custom-shortcuts'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-custom-shortcuts-updated-at'
const PROFILE = 'default'

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

  const readLocal = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const data = raw ? JSON.parse(raw) : []
      const updatedAt = localStorage.getItem(STORAGE_UPDATED_AT_KEY) || ''
      return { items: Array.isArray(data) ? data.filter((item): item is CustomShortcut => !!item && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.keys === 'string' && typeof item.action === 'string') : [], updatedAt }
    } catch {
      return { items: [], updatedAt: '' }
    }
  }, [])
  const writeLocal = useCallback((next: CustomShortcut[], updatedAt: string) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, updatedAt)
  }, [])

  useEffect(() => {
    const local = readLocal()
    setShortcuts(local.items)
    void (async () => {
      try {
        const remote = await api.preferences.get(PROFILE)
        const remoteItems = Array.isArray(remote.customShortcuts) ? remote.customShortcuts : []
        const remoteUpdatedAt = remote.customShortcutsUpdatedAt || ''
        const localMs = Date.parse(local.updatedAt || '')
        const remoteMs = Date.parse(remoteUpdatedAt || '')
        if (remoteItems.length === 0 && local.items.length > 0) {
          const pushedAt = local.updatedAt || new Date().toISOString()
          await api.preferences.update({ customShortcuts: local.items, customShortcutsUpdatedAt: pushedAt }, PROFILE)
          return
        }
        if (!Number.isNaN(remoteMs) && (Number.isNaN(localMs) || remoteMs >= localMs)) {
          setShortcuts(remoteItems)
          writeLocal(remoteItems, remoteUpdatedAt || new Date().toISOString())
          return
        }
        if (!Number.isNaN(localMs) && (Number.isNaN(remoteMs) || localMs > remoteMs)) {
          await api.preferences.update({ customShortcuts: local.items, customShortcutsUpdatedAt: local.updatedAt }, PROFILE)
        }
      } catch {}
    })()
  }, [readLocal, writeLocal])

  const persist = useCallback((next: CustomShortcut[], updatedAt?: string) => {
    const nextUpdatedAt = updatedAt || new Date().toISOString()
    setShortcuts(next)
    writeLocal(next, nextUpdatedAt)
    void api.preferences.update({ customShortcuts: next, customShortcutsUpdatedAt: nextUpdatedAt }, PROFILE).catch(() => {})
  }, [])

  const addShortcut = useCallback((s: Omit<CustomShortcut, 'id'>) => {
    persist([...shortcuts, { ...s, id: Date.now().toString(36) + Math.random().toString(36).slice(2) }], new Date().toISOString())
  }, [shortcuts, persist])

  const removeShortcut = useCallback((id: string) => {
    persist(shortcuts.filter((s) => s.id !== id), new Date().toISOString())
  }, [shortcuts, persist])

  return { shortcuts, addShortcut, removeShortcut }
}
