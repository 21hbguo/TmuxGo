'use client'

import { useEffect } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'

const BUILD_ID = process.env.NEXT_PUBLIC_APP_BUILD_ID || 'dev'
const VERSION_URL = '/api/version'
const VERSION_CHECK_MS = 60000
const VERSION_ACK_KEY = 'tmuxgo-version-ack'

export function AppVersionGuard() {
  const pushToast = useConsoleStore((state) => state.pushToast)

  useEffect(() => {
    let stopped = false
    let notified = false
    const checkVersion = async () => {
      try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' })
        if (!response.ok) return
        const data = await response.json() as { buildId?: string }
        if (stopped || !data.buildId || data.buildId === BUILD_ID || notified) return
        const ack = window.sessionStorage.getItem(VERSION_ACK_KEY)
        if (ack === data.buildId) return
        notified = true
        window.sessionStorage.setItem(VERSION_ACK_KEY, data.buildId)
        pushToast({ type: 'info', message: 'New frontend version available. Refresh to update.', durationMs: 6000 })
      } catch {}
    }
    void checkVersion()
    const timer = window.setInterval(() => void checkVersion(), VERSION_CHECK_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [pushToast])

  return null
}
