'use client'

import { useCallback } from 'react'
import type { Window } from '@/types'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'

export function useWindowQueryState(hostId: string, sessionId: string) {
  const queryClient = useOptionalQueryClient()
  const queryKey = ['windows', hostId, sessionId] as const
  const getWindows = useCallback(() => {
    if (!queryClient || !hostId || !sessionId) return []
    return (queryClient.getQueryData(queryKey) as Window[] | undefined) || []
  }, [hostId, queryClient, sessionId])
  const setWindows = useCallback((windows: Window[]) => {
    if (!queryClient || !hostId || !sessionId) return
    queryClient.setQueryData(queryKey, windows)
  }, [hostId, queryClient, sessionId])
  return { getWindows, setWindows }
}
