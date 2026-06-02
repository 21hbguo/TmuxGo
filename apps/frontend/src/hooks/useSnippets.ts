'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Snippet } from '@/types'
export type { Snippet } from '@/types'

const STORAGE_KEY = 'tmuxgo-snippets'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-snippets-updated-at'
const PROFILE = 'default'

const defaultSnippetCommands = [
  { id: '1', nameKey: 'snippets.listFiles' as const, command: 'ls -la', category: 'basic' },
  { id: '2', nameKey: 'snippets.diskUsage' as const, command: 'df -h', category: 'system' },
  { id: '3', nameKey: 'snippets.memoryUsage' as const, command: 'free -h', category: 'system' },
  { id: '4', nameKey: 'snippets.processList' as const, command: 'ps aux | head -20', category: 'system' },
  { id: '5', nameKey: 'snippets.dockerContainers' as const, command: 'docker ps', category: 'docker' },
  { id: '6', nameKey: 'snippets.gitStatus' as const, command: 'git status', category: 'git' },
  { id: '7', nameKey: 'snippets.gitLog' as const, command: 'git log --oneline -10', category: 'git' },
]

export const SNIPPET_NAME_KEYS = defaultSnippetCommands.reduce<Record<string, string>>((acc, s) => {
  acc[s.id] = s.nameKey
  return acc
}, {})

export function getDefaultSnippets(): Snippet[] {
  return defaultSnippetCommands.map((s) => ({ id: s.id, name: s.nameKey, command: s.command, category: s.category }))
}

export function useSnippets() {
  const [snippets, setSnippets] = useState<Snippet[]>([])

  const readLocal = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const data = raw ? JSON.parse(raw) : []
      const updatedAt = localStorage.getItem(STORAGE_UPDATED_AT_KEY) || ''
      return { items: Array.isArray(data) ? data.filter((item): item is Snippet => !!item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.command === 'string' && typeof item.category === 'string') : [], updatedAt }
    } catch {
      return { items: [] as Snippet[], updatedAt: '' }
    }
  }, [])
  const writeLocal = useCallback((next: Snippet[], updatedAt: string) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, updatedAt)
  }, [])

  useEffect(() => {
    const local = readLocal()
    if (local.items.length > 0) {
      setSnippets(local.items)
    } else {
      const defaults = getDefaultSnippets()
      setSnippets(defaults)
      writeLocal(defaults, local.updatedAt || new Date().toISOString())
    }
    void (async () => {
      try {
        const remote = await api.preferences.get(PROFILE)
        const remoteItems = Array.isArray(remote.snippets) ? remote.snippets : []
        const remoteUpdatedAt = remote.snippetsUpdatedAt || ''
        const localData = readLocal()
        const localMs = Date.parse(localData.updatedAt || '')
        const remoteMs = Date.parse(remoteUpdatedAt || '')
        if (remoteItems.length === 0 && localData.items.length > 0) {
          const pushedAt = localData.updatedAt || new Date().toISOString()
          await api.preferences.update({ snippets: localData.items, snippetsUpdatedAt: pushedAt }, PROFILE)
          return
        }
        if (!Number.isNaN(remoteMs) && (Number.isNaN(localMs) || remoteMs >= localMs)) {
          setSnippets(remoteItems)
          writeLocal(remoteItems, remoteUpdatedAt || new Date().toISOString())
          return
        }
        if (!Number.isNaN(localMs) && (Number.isNaN(remoteMs) || localMs > remoteMs)) {
          await api.preferences.update({ snippets: localData.items, snippetsUpdatedAt: localData.updatedAt }, PROFILE)
        }
      } catch {}
    })()
  }, [readLocal, writeLocal])

  const persist = useCallback((next: Snippet[], updatedAt?: string) => {
    const nextUpdatedAt = updatedAt || new Date().toISOString()
    setSnippets(next)
    writeLocal(next, nextUpdatedAt)
    void api.preferences.update({ snippets: next, snippetsUpdatedAt: nextUpdatedAt }, PROFILE).catch(() => {})
  }, [writeLocal])

  const addSnippet = useCallback((s: Omit<Snippet, 'id'>) => {
    persist([...snippets, { ...s, id: Date.now().toString(36) + Math.random().toString(36).slice(2) }], new Date().toISOString())
  }, [snippets, persist])

  const removeSnippet = useCallback((id: string) => {
    persist(snippets.filter((s) => s.id !== id), new Date().toISOString())
  }, [snippets, persist])

  return { snippets, addSnippet, removeSnippet }
}
