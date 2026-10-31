'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { CustomShortcut, ShortcutStep } from '@/types'
import { shortcutIdentity } from '@/lib/shortcut-bundle'
export type { CustomShortcut, ShortcutStep } from '@/types'

const STORAGE_KEY = 'tmuxgo-custom-shortcuts'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-custom-shortcuts-updated-at'
const SHORTCUTS_CHANGED_EVENT = 'tmuxgo-custom-shortcuts-changed'
const PROFILE = 'default'

// 纯逻辑（按键编码、步骤展开、宏身份）都在 lib 里；这里只保留持久化与同步。
// 导出名保持不变，老的 import 路径不用改。
export { formatKeyEvent, keysToEscape, normalizeShortcutKeys } from '@/lib/shortcut-keys'
export { describeShortcut, shortcutToInput, shortcutToSteps, stepToInput } from '@/lib/shortcut-bundle'

export function useCustomShortcuts() {
  const [shortcuts, setShortcuts] = useState<CustomShortcut[]>([])

  const readLocal = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const data = raw ? JSON.parse(raw) : []
      const updatedAt = localStorage.getItem(STORAGE_UPDATED_AT_KEY) || ''
      return {
        items: Array.isArray(data)
          ? data.filter((item): item is CustomShortcut => {
              if (!item || typeof item.id !== 'string' || typeof item.label !== 'string') return false
              if (Array.isArray(item.steps) && item.steps.length > 0) {
                return item.steps.every(
                  (s: ShortcutStep) =>
                    !!s &&
                    (s.type === 'wait'
                      ? typeof s.ms === 'number' && s.ms > 0
                      : s.type === 'text'
                        ? typeof s.text === 'string' && s.text.length > 0
                        : s.type === 'keys'
                          ? typeof s.keys === 'string' && s.keys.length > 0
                          : false),
                )
              }
              if (item.mode === 'text')
                return (
                  typeof item.text === 'string' &&
                  item.text.length > 0 &&
                  (typeof item.appendEnter === 'undefined' || typeof item.appendEnter === 'boolean')
                )
              return (
                (item.mode === undefined || item.mode === 'keys') &&
                typeof item.keys === 'string' &&
                item.keys.length > 0
              )
            })
          : [],
        updatedAt,
      }
    } catch {
      return { items: [], updatedAt: '' }
    }
  }, [])
  const writeLocal = useCallback((next: CustomShortcut[], updatedAt: string) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, updatedAt)
    window.dispatchEvent(new Event(SHORTCUTS_CHANGED_EVENT))
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
          await api.preferences.update(
            { customShortcuts: local.items, customShortcutsUpdatedAt: local.updatedAt },
            PROFILE,
          )
        }
      } catch {}
    })()
  }, [readLocal, writeLocal])

  useEffect(() => {
    const refresh = () => setShortcuts(readLocal().items)
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(SHORTCUTS_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [readLocal])

  const persist = useCallback(
    (next: CustomShortcut[], updatedAt?: string) => {
      const nextUpdatedAt = updatedAt || new Date().toISOString()
      setShortcuts(next)
      writeLocal(next, nextUpdatedAt)
      void api.preferences
        .update({ customShortcuts: next, customShortcutsUpdatedAt: nextUpdatedAt }, PROFILE)
        .catch(() => {})
    },
    [writeLocal],
  )

  const addShortcut = useCallback(
    (s: Omit<CustomShortcut, 'id'>) => {
      persist(
        [...shortcuts, { ...s, id: Date.now().toString(36) + Math.random().toString(36).slice(2) }],
        new Date().toISOString(),
      )
    },
    [shortcuts, persist],
  )

  const updateShortcut = useCallback(
    (id: string, s: Omit<CustomShortcut, 'id'>) => {
      persist(
        shortcuts.map((item) => (item.id === id ? { ...s, id } : item)),
        new Date().toISOString(),
      )
    },
    [shortcuts, persist],
  )

  const removeShortcut = useCallback(
    (id: string) => {
      persist(
        shortcuts.filter((s) => s.id !== id),
        new Date().toISOString(),
      )
    },
    [shortcuts, persist],
  )

  const removeShortcuts = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids)
      persist(
        shortcuts.filter((s) => !idSet.has(s.id)),
        new Date().toISOString(),
      )
    },
    [shortcuts, persist],
  )

  // 批量导入：一次 persist，避免逐条 addShortcut 触发 N 次本地事件 + 服务端写入。
  // merge 按「label + 规范化步骤」去重（同内容不同 id 视为重复），replace 整体覆盖
  const importShortcuts = useCallback(
    (items: Array<Omit<CustomShortcut, 'id'>>, mode: 'merge' | 'replace') => {
      const stamp = Date.now().toString(36)
      const created = items.map((item, index) => ({
        ...item,
        id: `${stamp}-${index.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      }))
      if (mode === 'replace') {
        persist(created, new Date().toISOString())
        return { added: created.length, skipped: 0 }
      }
      const seen = new Set(shortcuts.map(shortcutIdentity))
      const fresh = created.filter((item) => !seen.has(shortcutIdentity(item)))
      persist([...shortcuts, ...fresh], new Date().toISOString())
      return { added: fresh.length, skipped: created.length - fresh.length }
    },
    [shortcuts, persist],
  )

  return { shortcuts, addShortcut, updateShortcut, removeShortcut, removeShortcuts, importShortcuts }
}
