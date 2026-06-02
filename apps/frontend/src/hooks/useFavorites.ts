'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { FavoriteItem } from '@/types'
export type { FavoriteItem } from '@/types'

const STORAGE_KEY = 'tmuxgo-favorites'
const STORAGE_UPDATED_AT_KEY = 'tmuxgo-favorites-updated-at'
const RECENT_KEY = 'tmuxgo-recent'
const MAX_RECENT = 20
const PROFILE = 'default'

export interface RecentItem {
  id: string
  type: 'host' | 'session' | 'pane'
  name: string
  target: string
  visitedAt: string
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])

  const readLocal = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const data = raw ? JSON.parse(raw) : []
      const updatedAt = localStorage.getItem(STORAGE_UPDATED_AT_KEY) || ''
      return { items: Array.isArray(data) ? data as FavoriteItem[] : [], updatedAt }
    } catch {
      return { items: [] as FavoriteItem[], updatedAt: '' }
    }
  }, [])
  const writeLocal = useCallback((next: FavoriteItem[], updatedAt: string) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    localStorage.setItem(STORAGE_UPDATED_AT_KEY, updatedAt)
  }, [])

  useEffect(() => {
    const local = readLocal()
    setFavorites(local.items)
    void (async () => {
      try {
        const remote = await api.preferences.get(PROFILE)
        const remoteItems = Array.isArray(remote.favorites) ? remote.favorites : []
        const remoteUpdatedAt = remote.favoritesUpdatedAt || ''
        const localMs = Date.parse(local.updatedAt || '')
        const remoteMs = Date.parse(remoteUpdatedAt || '')
        if (remoteItems.length === 0 && local.items.length > 0) {
          const pushedAt = local.updatedAt || new Date().toISOString()
          await api.preferences.update({ favorites: local.items, favoritesUpdatedAt: pushedAt }, PROFILE)
          return
        }
        if (!Number.isNaN(remoteMs) && (Number.isNaN(localMs) || remoteMs >= localMs)) {
          setFavorites(remoteItems)
          writeLocal(remoteItems, remoteUpdatedAt || new Date().toISOString())
          return
        }
        if (!Number.isNaN(localMs) && (Number.isNaN(remoteMs) || localMs > remoteMs)) {
          await api.preferences.update({ favorites: local.items, favoritesUpdatedAt: local.updatedAt }, PROFILE)
        }
      } catch {}
    })()
  }, [readLocal, writeLocal])

  const persist = useCallback((next: FavoriteItem[], updatedAt?: string) => {
    const nextUpdatedAt = updatedAt || new Date().toISOString()
    setFavorites(next)
    writeLocal(next, nextUpdatedAt)
    void api.preferences.update({ favorites: next, favoritesUpdatedAt: nextUpdatedAt }, PROFILE).catch(() => {})
  }, [writeLocal])

  const addFavorite = useCallback((item: Omit<FavoriteItem, 'addedAt'>) => {
    if (favorites.some((f) => f.id === item.id)) return
    persist([{ ...item, addedAt: new Date().toISOString() }, ...favorites], new Date().toISOString())
  }, [favorites, persist])

  const removeFavorite = useCallback((id: string) => {
    persist(favorites.filter((f) => f.id !== id), new Date().toISOString())
  }, [favorites, persist])

  return { favorites, addFavorite, removeFavorite }
}

export function getRecentItems(): RecentItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((item): item is RecentItem => !!item && typeof item.id === 'string' && (item.type === 'host' || item.type === 'session' || item.type === 'pane') && typeof item.name === 'string' && typeof item.target === 'string' && typeof item.visitedAt === 'string') : []
  } catch {
    return []
  }
}

export function addToRecent(type: 'host' | 'session' | 'pane', id: string, name: string, target: string) {
  const recent: RecentItem[] = getRecentItems()
  const existing = recent.findIndex((r) => r.id === id)
  if (existing >= 0) recent.splice(existing, 1)
  recent.unshift({ id, type, name, target, visitedAt: new Date().toISOString() })
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)))
}

export function clearRecent() {
  localStorage.setItem(RECENT_KEY, JSON.stringify([]))
}
