'use client'
import { useCallback } from 'react'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useOptionalQueryClient } from './useOptionalQueryClient'

export function useSessionSnapshotSync() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActivePane = useConsoleStore((state) => state.setActivePane)
  const queryClient = useOptionalQueryClient()
  const refreshSnapshot = useCallback(async () => {
    if (!activeHostId || !activeSessionId) return null
    const snapshot = await api.snapshot.get(activeHostId, activeSessionId)
    queryClient?.setQueryData(['session-snapshot', activeHostId, activeSessionId], snapshot)
    if (snapshot.activePaneId) setActivePane(snapshot.activePaneId)
    return snapshot
  }, [activeHostId, activeSessionId, queryClient, setActivePane])
  const resolveActivePaneId = useCallback(async () => {
    if (!activeHostId || !activeSessionId) return useConsoleStore.getState().activePaneId
    const snapshot = await api.snapshot.get(activeHostId, activeSessionId)
    const paneId = snapshot.activePaneId || (snapshot.panes || []).find((pane: any) => pane.active)?.id || useConsoleStore.getState().activePaneId
    queryClient?.setQueryData(['session-snapshot', activeHostId, activeSessionId], snapshot)
    if (paneId) setActivePane(paneId)
    return paneId
  }, [activeHostId, activeSessionId, queryClient, setActivePane])
  return { refreshSnapshot, resolveActivePaneId }
}
