'use client'

import { useQuery } from '@tanstack/react-query'
import { fetchAppVersion } from '@/lib/app-version'

export function useAppVersion(enabled = true) {
  return useQuery({
    queryKey: ['app-version'],
    queryFn: fetchAppVersion,
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? 60000 : false,
  })
}
