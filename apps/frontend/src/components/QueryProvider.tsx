'use client'

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

function QueryRecovery() {
  const queryClient = useQueryClient()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const recover = () => {
      if (document.visibilityState !== 'visible' || timerRef.current !== null) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (document.visibilityState !== 'visible') return
        window.dispatchEvent(new Event('tmuxgo-app-recovered'))
        void queryClient.refetchQueries({ type: 'active', stale: true })
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
