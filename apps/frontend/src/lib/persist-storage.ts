import type { StateStorage } from 'zustand/middleware'

const DEFAULT_DEBOUNCE_MS = 120

interface PendingWrite {
  key: string
  value: string
}

let activeFlush: (() => void) | null = null

export function createDebouncedStorage(debounceMs = DEFAULT_DEBOUNCE_MS): StateStorage {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: PendingWrite | null = null
  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!pending) return
    const { key, value } = pending
    pending = null
    try {
      const current = localStorage.getItem(key)
      if (current === value) return
      localStorage.setItem(key, value)
    } catch {}
  }
  activeFlush = flush
  if (typeof window !== 'undefined') {
    const handleHide = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush, { capture: true })
    document.addEventListener('visibilitychange', handleHide)
    window.addEventListener('beforeunload', flush, { capture: true })
  }
  return {
    getItem: (key) => {
      if (typeof window === 'undefined') return null
      return localStorage.getItem(key)
    },
    setItem: (key, value) => {
      if (typeof window === 'undefined') return
      pending = { key, value }
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, debounceMs)
    },
    removeItem: (key) => {
      if (typeof window === 'undefined') return
      if (pending && pending.key === key) {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        pending = null
      }
      try {
        localStorage.removeItem(key)
      } catch {}
    },
  }
}

export function flushPersistedStorage() {
  activeFlush?.()
}
