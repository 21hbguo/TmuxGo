'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { CustomShortcut, ShortcutStep } from '@/types'
export type { CustomShortcut, ShortcutStep } from '@/types'

const STORAGE_KEY = 'tmuxgo-custom-shortcuts'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-custom-shortcuts-updated-at'
const SHORTCUTS_CHANGED_EVENT = 'tmuxgo-custom-shortcuts-changed'
const PROFILE = 'default'

const KEY_MAP: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  space: ' ',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  insert: '\x1b[2~',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
}

// Shift 只有方向/编辑键有独立序列（CSI 1;2X）；功能键没有 Shift 变体，按原键发
const SHIFT_KEY_MAP: Record<string, string> = {
  up: '\x1b[1;2A',
  down: '\x1b[1;2B',
  right: '\x1b[1;2C',
  left: '\x1b[1;2D',
  home: '\x1b[1;2H',
  end: '\x1b[1;2F',
  insert: '\x1b[2;2~',
  delete: '\x1b[3;2~',
  pageup: '\x1b[5;2~',
  pagedown: '\x1b[6;2~',
}
// Ctrl+符号的 ASCII 控制位（@ _ 等），其余符号无标准编码
const CTRL_SYMBOL_MAP: Record<string, string> = {
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '?': '\x7f',
}
const MODIFIER_TOKENS = ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd']
const isAlpha = (ch: string) => /^[a-z]$/i.test(ch)

export function keysToEscape(keys: string): string {
  const rawParts = keys.split('+').map((s) => s.trim())
  const tokens = rawParts.map((p) => p.toLowerCase())
  const hasCtrl = tokens.includes('ctrl') || tokens.includes('control')
  const hasShift = tokens.includes('shift')
  // Alt / Cmd 在 xterm 系终端里都编码成 ESC 前缀（Meta 键 = ESC + 键）。少了这层
  // 前缀，"Alt+5" 会退化成裸 "5"：tmux 里就从 M-5(select-layout tiled) 变成选窗口，
  // 布局类绑定静默失效，且用户看不出原因。
  const hasMeta = tokens.includes('alt') || tokens.includes('meta') || tokens.includes('cmd')
  const withMeta = (payload: string) => (hasMeta ? `\x1b${payload}` : payload)
  const keyRaw = rawParts.find((_, i) => !MODIFIER_TOKENS.includes(tokens[i])) || ''

  if (!keyRaw) return ''
  const key = keyRaw.toLowerCase()

  // Ctrl+Space 是 NUL（tmux 默认 prefix 之外最常用的一个键），必须在空格这层
  // 普通映射之前截住，否则会被当成裸空格发出去
  if (hasCtrl && key === 'space') return withMeta('\x00')

  const special = KEY_MAP[key]
  if (special) {
    if (key === 'tab' && hasShift) return withMeta('\x1b[Z')
    if (hasShift && SHIFT_KEY_MAP[key]) return withMeta(SHIFT_KEY_MAP[key])
    return withMeta(special)
  }

  if (key.length === 1) {
    if (hasCtrl) {
      const upper = key.toUpperCase()
      const c = upper.charCodeAt(0)
      if (c >= 65 && c <= 90) return withMeta(String.fromCharCode(c - 64))
      const symbol = CTRL_SYMBOL_MAP[key]
      return symbol ? withMeta(symbol) : ''
    }
    // 单键：字母按录入时的 Shift 定大小写（不带 Shift 就是小写，不会再被旧的
    // 全大写格式化顶成大写）；数字/符号保持原样
    if (isAlpha(key)) return withMeta(hasShift ? key.toUpperCase() : key)
    return withMeta(hasShift ? key.toUpperCase() : keyRaw)
  }

  return ''
}

export function stepToInput(step: ShortcutStep): string {
  if (step.type === 'keys') return keysToEscape(step.keys || '')
  if (step.type === 'text') return `${step.text || ''}${step.appendEnter === true ? '\r' : ''}`
  return ''
}

export function shortcutToSteps(shortcut: CustomShortcut): ShortcutStep[] {
  if (Array.isArray(shortcut.steps) && shortcut.steps.length > 0) return shortcut.steps
  if (shortcut.mode === 'text') return [{ type: 'text', text: shortcut.text || '', appendEnter: shortcut.appendEnter }]
  return shortcut.keys ? [{ type: 'keys', keys: shortcut.keys }] : []
}

export function shortcutToInput(shortcut: CustomShortcut): string {
  return shortcutToSteps(shortcut).map(stepToInput).join('')
}

export function describeShortcut(shortcut: CustomShortcut): string {
  return shortcutToSteps(shortcut)
    .map((s) => (s.type === 'wait' ? `wait ${s.ms}ms` : s.type === 'text' ? s.text || '' : s.keys || ''))
    .join(' › ')
}

export function formatKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  const skip = ['Control', 'Alt', 'Shift', 'Meta']
  // 不改写大小写：录制 'a' 就该发 'a'，Shift 由修饰符表达；空格统一叫 Space
  const key = skip.includes(e.key) ? '' : e.key === ' ' ? 'Space' : e.key
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

  return { shortcuts, addShortcut, updateShortcut, removeShortcut, removeShortcuts }
}
