'use client'
import { useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useOptionalQueryClient } from './useOptionalQueryClient'

export function toggleCachedSnapshotZoom(snapshot: any, paneId: string) {
  if (!snapshot || typeof snapshot !== 'object' || !paneId) return snapshot
  const panes = Array.isArray(snapshot.panes) ? snapshot.panes : []
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
  const targetPane = panes.find((pane: any) => pane?.id === paneId) || null
  const activeWindow = windows.find((window: any) => window?.id === snapshot.activeWindowId) || windows.find((window: any) => window?.active) || null
  const targetWindowId = String(targetPane?.windowId || (snapshot.activePaneId === paneId ? activeWindow?.id : '') || '')
  if (!targetWindowId) return snapshot
  const targetWindow = windows.find((window: any) => window?.id === targetWindowId) || activeWindow
  const nextZoomed = !Boolean(targetWindow?.zoomed)
  return {
    ...snapshot,
    activeWindowId: targetWindowId,
    activePaneId: paneId,
    windows: windows.map((window: any) => window?.id === targetWindowId ? { ...window, active: true, zoomed: nextZoomed } : window?.active ? { ...window, active: false } : window),
    panes: panes.map((pane: any) => {
      const sameWindow = String(pane?.windowId || '') === targetWindowId
      if (sameWindow) return { ...pane, active: pane?.id === paneId }
      return pane?.active ? { ...pane, active: false } : pane
    }),
  }
}

function applyWindowZoom(snapshot: any, paneId: string, zoomed: boolean) {
  if (!snapshot || typeof snapshot !== 'object' || !paneId) return snapshot
  const panes = Array.isArray(snapshot.panes) ? snapshot.panes : []
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
  const targetPane = panes.find((pane: any) => pane?.id === paneId) || null
  const activeWindow = windows.find((window: any) => window?.id === snapshot.activeWindowId) || windows.find((window: any) => window?.active) || null
  const targetWindowId = String(targetPane?.windowId || (snapshot.activePaneId === paneId ? activeWindow?.id : '') || '')
  if (!targetWindowId) return snapshot
  return {
    ...snapshot,
    activeWindowId: targetWindowId,
    activePaneId: paneId,
    windows: windows.map((window: any) => window?.id === targetWindowId ? { ...window, active: true, zoomed } : window?.active ? { ...window, active: false } : window),
    panes: panes.map((pane: any) => {
      const sameWindow = String(pane?.windowId || '') === targetWindowId
      if (sameWindow) return { ...pane, active: pane?.id === paneId }
      return pane?.active ? { ...pane, active: false } : pane
    }),
  }
}

function getCurrentWindowZoomed(snapshot: any, paneId: string): boolean | null {
  if (!snapshot || typeof snapshot !== 'object' || !paneId) return null
  const panes = Array.isArray(snapshot.panes) ? snapshot.panes : []
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
  const targetPane = panes.find((pane: any) => pane?.id === paneId)
  const activeWindow = windows.find((window: any) => window?.id === snapshot.activeWindowId) || windows.find((window: any) => window?.active) || null
  const targetWindowId = targetPane?.windowId || (snapshot.activePaneId === paneId ? activeWindow?.id : null)
  if (!targetWindowId) return null
  const targetWindow = windows.find((window: any) => window?.id === targetWindowId) || activeWindow
  return targetWindow ? Boolean(targetWindow.zoomed) : null
}

export function useSessionSnapshotSync() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActivePane = useConsoleStore((state) => state.setActivePane)
  const queryClient = useOptionalQueryClient()
  const inFlightRef = useRef<{ key: string; promise: Promise<any> } | null>(null)
  const expectedZoomedByWindowRef = useRef<Map<string, boolean>>(new Map())
  const pendingZoomedByWindowRef = useRef<Map<string, boolean>>(new Map())
  const getSnapshotKey = useCallback(() => activeHostId && activeSessionId ? ['session-snapshot', activeHostId, activeSessionId] : null, [activeHostId, activeSessionId])
  const getPaneId = useCallback((snapshot: any) => snapshot?.activePaneId || (Array.isArray(snapshot?.panes) ? snapshot.panes.find((pane: any) => pane.active)?.id : null) || null, [])
  const applySnapshot = useCallback((snapshot: any) => {
    if (!snapshot || typeof snapshot !== 'object') {
      setActivePane(null)
      return null
    }
    const nextSnapshot = {
      ...snapshot,
      windows: (Array.isArray(snapshot.windows) ? snapshot.windows : []).map((window: any) => {
        const windowId = String(window?.id || '')
        if (!windowId) return window
        const zoomed = Boolean(window.zoomed)
        const pendingZoomed = pendingZoomedByWindowRef.current.get(windowId)
        if (pendingZoomed === undefined) {
          expectedZoomedByWindowRef.current.set(windowId, zoomed)
          return window
        }
        if (pendingZoomed === zoomed) {
          pendingZoomedByWindowRef.current.delete(windowId)
          expectedZoomedByWindowRef.current.set(windowId, zoomed)
          return window
        }
        return { ...window, zoomed: pendingZoomed }
      }),
    }
    const paneId = getPaneId(nextSnapshot)
    const key = getSnapshotKey()
    if (key) queryClient?.setQueryData(key, nextSnapshot)
    setActivePane(paneId)
    return paneId
  }, [getPaneId, getSnapshotKey, queryClient, setActivePane])
  const readCachedPaneId = useCallback(() => {
    const key = getSnapshotKey()
    const cached = key ? queryClient?.getQueryData?.(key) : null
    const paneId = getPaneId(cached)
    setActivePane(paneId)
    return paneId
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
    if (inFlightRef.current?.key === requestKey) inFlightRef.current = null
    applySnapshot(snapshot)
    return snapshot
  }, [activeHostId, activeSessionId, applySnapshot])
  const optimisticallyToggleWindowZoom = useCallback((paneId: string | null) => {
    const key = getSnapshotKey()
    if (!key || !paneId || !queryClient) return null
    let nextSnapshot: any = null
    queryClient.setQueryData(key, (current: any) => {
      const cached = getCurrentWindowZoomed(current, paneId)
      const targetPane = (current?.panes || []).find((p: any) => p?.id === paneId)
      const activeWindow = (current?.windows || []).find((w: any) => w?.id === current?.activeWindowId) || (current?.windows || []).find((w: any) => w?.active) || null
      const targetWindowId = targetPane?.windowId || (current?.activePaneId === paneId ? activeWindow?.id : null)
      if (!targetWindowId) {
        nextSnapshot = current
        return current
      }
      const lastExpected = expectedZoomedByWindowRef.current.get(String(targetWindowId))
      const baseZoomed = lastExpected !== undefined ? lastExpected : (cached === null ? false : cached)
      const nextZoomed = !baseZoomed
      expectedZoomedByWindowRef.current.set(String(targetWindowId), nextZoomed)
      pendingZoomedByWindowRef.current.set(String(targetWindowId), nextZoomed)
      nextSnapshot = applyWindowZoom(current, paneId, nextZoomed)
      return nextSnapshot
    })
    if (nextSnapshot?.activePaneId) setActivePane(nextSnapshot.activePaneId)
    return nextSnapshot
  }, [getSnapshotKey, queryClient, setActivePane])
  const discardOptimisticWindowZoom = useCallback((paneId: string | null) => {
    const key = getSnapshotKey()
    const current = key ? queryClient?.getQueryData?.(key) : null
    const panes = Array.isArray((current as any)?.panes) ? (current as any).panes : []
    const windows = Array.isArray((current as any)?.windows) ? (current as any).windows : []
    const targetPane = panes.find((pane: any) => pane?.id === paneId)
    const activeWindow = windows.find((window: any) => window?.id === (current as any)?.activeWindowId) || windows.find((window: any) => window?.active) || null
    const windowId = String(targetPane?.windowId || ((current as any)?.activePaneId === paneId ? activeWindow?.id : '') || '')
    if (!windowId) return
    pendingZoomedByWindowRef.current.delete(windowId)
    expectedZoomedByWindowRef.current.delete(windowId)
  }, [getSnapshotKey, queryClient])
  const readSnapshotPaneId = useCallback((snapshot: any) => {
    const paneId = getPaneId(snapshot)
    setActivePane(paneId)
    return paneId
  }, [getPaneId, setActivePane])
  const resolveActivePaneId = useCallback(async () => {
    const cachedPaneId = readCachedPaneId()
    if (cachedPaneId || !activeHostId || !activeSessionId) return cachedPaneId
    try {
      const snapshot = await refreshSnapshot()
      return readSnapshotPaneId(snapshot)
    } catch {
      setActivePane(null)
      return null
    }
  }, [activeHostId, activeSessionId, readCachedPaneId, readSnapshotPaneId, refreshSnapshot, setActivePane])
  const resolveFreshActivePaneId = useCallback(async () => {
    const cachedPaneId = readCachedPaneId()
    if (!activeHostId || !activeSessionId) return cachedPaneId
    try {
      const snapshot = await refreshSnapshot()
      return readSnapshotPaneId(snapshot)
    } catch {
      if (cachedPaneId) return cachedPaneId
      setActivePane(null)
      return null
    }
  }, [activeHostId, activeSessionId, readCachedPaneId, readSnapshotPaneId, refreshSnapshot, setActivePane])
  const syncAfterWindowChange = useCallback(async () => {
    const snapshot = await refreshSnapshot()
    return applySnapshot(snapshot)
  }, [applySnapshot, refreshSnapshot])
  return { refreshSnapshot, resolveActivePaneId, resolveFreshActivePaneId, syncAfterWindowChange, optimisticallyToggleWindowZoom, discardOptimisticWindowZoom }
}
