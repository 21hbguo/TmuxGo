'use client'

import { useEffect } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { APP_BUILD_ID, fetchAppVersion } from '@/lib/app-version'

const VERSION_CHECK_MS = 60000
const VERSION_ACK_KEY = 'tmuxgo-version-ack'

export function AppVersionGuard() {
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { t } = useTranslation()

  useEffect(() => {
    let stopped = false
    let notified = false
    const checkVersion = async () => {
      try {
        const data = await fetchAppVersion()
        if (stopped || !data.buildId || data.buildId === APP_BUILD_ID || notified) return
        const ack = window.sessionStorage.getItem(VERSION_ACK_KEY)
        if (ack === data.buildId) return
        notified = true
        window.sessionStorage.setItem(VERSION_ACK_KEY, data.buildId)
        pushToast({ type: 'info', message: t('version.newAvailable'), durationMs: 6000 })
      } catch {}
    }
    void checkVersion()
    const timer = window.setInterval(() => void checkVersion(), VERSION_CHECK_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [pushToast, t])

  return null
}
