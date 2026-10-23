'use client'

import { useCallback } from 'react'
import type { Window } from '@/types'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'

// queryKey 内容由 hostId/sessionId 决定；在回调内构造，避免数组字面量身份进 deps 造成无谓重建
const windowQueryKey = (hostId: string, sessionId: string) => ['windows', hostId, sessionId] as const

export function useWindowQueryState(hostId: string, sessionId: string) {
  const queryClient = useOptionalQueryClient()
  const getWindows = useCallback(() => {
    if (!queryClient || !hostId || !sessionId) return []
    return (queryClient.getQueryData(windowQueryKey(hostId, sessionId)) as Window[] | undefined) || []
  }, [hostId, queryClient, sessionId])
  const setWindows = useCallback(
    (windows: Window[]) => {
      if (!queryClient || !hostId || !sessionId) return
      queryClient.setQueryData(windowQueryKey(hostId, sessionId), windows)
    },
    [hostId, queryClient, sessionId],
  )
  return { getWindows, setWindows }
}
