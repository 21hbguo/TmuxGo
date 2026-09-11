'use client'

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { getApiBase } from '@/lib/runtime-endpoints'

const RECOVERY_PROBE_DELAYS = [0, 500, 1500, 3000, 6000]

async function waitForGateway() {
  for (const delay of RECOVERY_PROBE_DELAYS) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay))
    if (document.visibilityState !== 'visible') return false
    try {
      const response = await fetch(`${getApiBase()}/health`, { cache: 'no-store' })
      if (response.ok) return true
    } catch {}
  }
  return false
}

function QueryRecovery() {
  const queryClient = useQueryClient()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probingRef = useRef(false)
  useEffect(() => {
    const recover = () => {
      if (document.visibilityState !== 'visible' || timerRef.current !== null || probingRef.current) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        probingRef.current = true
        void (async () => {
          const reachable = await waitForGateway()
          probingRef.current = false
          if (!reachable || document.visibilityState !== 'visible') return
          window.dispatchEvent(new Event('tmuxgo-app-recovered'))
          void queryClient.refetchQueries({ type: 'active', stale: true })
        })()
      }, 250)
    }
    document.addEventListener('visibilitychange', recover)
    window.addEventListener('focus', recover)
    window.addEventListener('pageshow', recover)
    window.addEventListener('online', recover)
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', recover)
      window.removeEventListener('focus', recover)
      window.removeEventListener('pageshow', recover)
      window.removeEventListener('online', recover)
    }
  }, [queryClient])
  return null
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 3000,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}><QueryRecovery />{children}</QueryClientProvider>
  )
}
