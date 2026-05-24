'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'

type BeforeInstallPromptEvent=Event&{
  prompt:()=>Promise<void>
  userChoice:Promise<{outcome:'accepted'|'dismissed';platform:string}>
}

const DISMISS_KEY='tmuxu-install-banner-dismissed'

function isStandalone() {
  if (typeof window==='undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

function isIos() {
  if (typeof navigator==='undefined') return false
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
}

function isSafari() {
  if (typeof navigator==='undefined') return false
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
}

export function InstallAppBanner() {
  const { t } = useTranslation()
  const [ready, setReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosGuide, setShowIosGuide] = useState(false)

  useEffect(() => {
    if (typeof window==='undefined') return
    setDismissed(localStorage.getItem(DISMISS_KEY)==='1')
    setShowIosGuide(isIos() && isSafari() && !isStandalone())
    setReady(true)
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    const handleInstalled = () => {
      setDeferredPrompt(null)
      setShowIosGuide(false)
      setDismissed(true)
      localStorage.setItem(DISMISS_KEY,'1')
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  if (!ready || dismissed || isStandalone()) return null
  if (!deferredPrompt && !showIosGuide) return null

  const close = () => {
    setDismissed(true)
    localStorage.setItem(DISMISS_KEY,'1')
  }

  const install = async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'accepted') {
      setDismissed(true)
      localStorage.setItem(DISMISS_KEY,'1')
    }
    setDeferredPrompt(null)
  }

  return (
    <div className="fixed left-3 right-3 top-3 z-[70]">
      <div className="rounded-2xl border border-[var(--line)] bg-bg-1/95 px-3 py-3 shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent text-lg font-bold">⌘</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-1">{t('install.title')}</div>
            <div className="mt-1 text-xs leading-5 text-text-2">{showIosGuide ? t('install.iosDesc') : t('install.desc')}</div>
          </div>
          <button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-3 active:bg-bg-2" onClick={close}>×</button>
        </div>
        <div className="mt-3 flex gap-2">
          {deferredPrompt && <button type="button" className="flex-1 rounded-xl bg-accent px-3 py-2 text-sm font-medium text-bg-0 active:scale-[0.98]" onClick={install}>{t('install.action')}</button>}
          {showIosGuide && <button type="button" className="flex-1 rounded-xl bg-accent px-3 py-2 text-sm font-medium text-bg-0 active:scale-[0.98]" onClick={close}>{t('install.gotIt')}</button>}
          <button type="button" className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm text-text-2 active:bg-bg-2" onClick={close}>{t('install.later')}</button>
        </div>
      </div>
    </div>
  )
}
