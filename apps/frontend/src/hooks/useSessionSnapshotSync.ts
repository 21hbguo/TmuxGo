'use client'
import { useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useOptionalQueryClient } from './useOptionalQueryClient'

export function useSessionSnapshotSync() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActivePane = useConsoleStore((state) => state.setActivePane)
  const queryClient = useOptionalQueryClient()
  const inFlightRef = useRef<{ key: string; promise: Promise<any> } | null>(null)
  const getSnapshotKey = useCallback(() => activeHostId && activeSessionId ? ['session-snapshot', activeHostId, activeSessionId] : null, [activeHostId, activeSessionId])
  const getPaneId = useCallback((snapshot: any) => snapshot?.activePaneId || (Array.isArray(snapshot?.panes) ? snapshot.panes.find((pane: any) => pane.active)?.id : null) || null, [])
  const applySnapshot = useCallback((snapshot: any) => {
    const paneId = getPaneId(snapshot)
    const key = getSnapshotKey()
    if (key) queryClient?.setQueryData(key, snapshot)
    if (paneId) setActivePane(paneId)
    return paneId
  }, [getPaneId, getSnapshotKey, queryClient, setActivePane])
  const readCachedPaneId = useCallback(() => {
    const key = getSnapshotKey()
    const cached = key ? queryClient?.getQueryData?.(key) : null
    const paneId = getPaneId(cached)
    if (paneId) {
      setActivePane(paneId)
      return paneId
    }
    return null
  }, [getPaneId, getSnapshotKey, queryClient, setActivePane])
  const refreshSnapshot = useCallback(async () => {
    if (!activeHostId || !activeSessionId) return null
    const requestKey = `${activeHostId}:${activeSessionId}`
    if (!inFlightRef.current || inFlightRef.current.key !== requestKey) {
      const promise = api.snapshot.get(activeHostId, activeSessionId).finally(() => {
        if (inFlightRef.current?.key === requestKey) inFlightRef.current = null
      })
      inFlightRef.current = { key: requestKey, promise }
    }
    const snapshot = await inFlightRef.current.promise
    applySnapshot(snapshot)
    return snapshot
  }, [activeHostId, activeSessionId, applySnapshot])
  const resolveActivePaneId = useCallback(async () => {
    const cachedPaneId = readCachedPaneId()
    if (cachedPaneId || !activeHostId || !activeSessionId) return cachedPaneId
    try {
      const snapshot = await refreshSnapshot()
      return getPaneId(snapshot) || useConsoleStore.getState().activePaneId
    } catch {
      return useConsoleStore.getState().activePaneId
    }
  }, [activeHostId, activeSessionId, getPaneId, readCachedPaneId, refreshSnapshot])
  return { refreshSnapshot, resolveActivePaneId }
}
