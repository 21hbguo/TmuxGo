'use client'
import { useCallback, useSyncExternalStore } from 'react'
export interface SessionSplitGroup {
  id: string
  hostId: string
  primarySessionId: string
  secondarySessionId: string
  direction: 'horizontal' | 'vertical'
  primaryRatio: number
  createdAt: string
  updatedAt: string
}
type SplitGroupInput = { hostId: string; primarySessionId: string; secondarySessionId: string; direction?: 'horizontal' | 'vertical'; primaryRatio?: number }
const STORAGE_KEY = 'tmuxgo-split-groups'
const listeners = new Set<() => void>()
let cache: SessionSplitGroup[] | null = null
function readStorage() {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is SessionSplitGroup => !!item && typeof item.id === 'string' && typeof item.hostId === 'string' && typeof item.primarySessionId === 'string' && typeof item.secondarySessionId === 'string' && (item.direction === 'horizontal' || item.direction === 'vertical') && typeof item.primaryRatio === 'number')
  } catch {
    return []
  }
}
function writeStorage(next: SessionSplitGroup[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}
function emit() {
  listeners.forEach((listener) => listener())
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function getSnapshot() {
  if (!cache) cache = readStorage()
  return cache
}
export function useSplitGroups() {
  const groups = useSyncExternalStore(subscribe, getSnapshot)
  const create = useCallback((input: SplitGroupInput) => {
    const now = new Date().toISOString()
    const next: SessionSplitGroup = { id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, hostId: input.hostId, primarySessionId: input.primarySessionId, secondarySessionId: input.secondarySessionId, direction: input.direction || 'horizontal', primaryRatio: typeof input.primaryRatio === 'number' ? Math.min(0.8, Math.max(0.5, input.primaryRatio)) : 0.65, createdAt: now, updatedAt: now }
    cache = [...(cache || readStorage()), next]
    writeStorage(cache)
    emit()
    return next
  }, [])
  const update = useCallback((id: string, patch: Partial<Omit<SessionSplitGroup, 'id' | 'createdAt'>>) => {
    const current = cache || readStorage()
    const target = current.find((item) => item.id === id)
    if (!target) return
    const next: SessionSplitGroup = { ...target, ...patch, primaryRatio: typeof patch.primaryRatio === 'number' ? Math.min(0.8, Math.max(0.5, patch.primaryRatio)) : target.primaryRatio, updatedAt: new Date().toISOString() }
    cache = current.map((item) => item.id === id ? next : item)
    writeStorage(cache)
    emit()
  }, [])
  const remove = useCallback((id: string) => {
    cache = (cache || readStorage()).filter((item) => item.id !== id)
    writeStorage(cache)
    emit()
  }, [])
  return { groups, create, update, remove }
}
