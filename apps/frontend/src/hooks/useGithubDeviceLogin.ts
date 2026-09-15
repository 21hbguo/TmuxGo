import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { writeClipboardText } from '@/lib/clipboard-text'
import {
  GITHUB_DEVICE_LOGIN_URL,
  extractGithubDeviceLogin,
  normalizeTerminalText,
  openUrlInNewWindow,
} from '@/lib/terminal-links'
interface GithubDeviceLoginOptions {
  activeHostId: string
  sessionName?: string
}
export function useGithubDeviceLogin(options: GithubDeviceLoginOptions) {
  const { activeHostId, sessionName } = options
  const { t } = useTranslation()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [githubDeviceLogin, setGithubDeviceLogin] = useState<{ code: string; url: string } | null>(null)
  const githubDeviceLoginRef = useRef<{ code: string; url: string } | null>(null)
  const githubDeviceLoginDismissedRef = useRef('')
  const githubDeviceLoginBufferRef = useRef('')
  const githubAuthLoggedInRef = useRef<boolean | null>(null)
  const setGithubDeviceLoginState = useCallback((next: { code: string; url: string } | null) => {
    githubDeviceLoginRef.current = next
    setGithubDeviceLogin(next)
  }, [])
  const dismissGithubDeviceLogin = useCallback(() => {
    if (githubDeviceLoginRef.current?.code) githubDeviceLoginDismissedRef.current = githubDeviceLoginRef.current.code
    setGithubDeviceLoginState(null)
  }, [setGithubDeviceLoginState])
  const openGithubDeviceLogin = useCallback(() => {
    const url = githubDeviceLoginRef.current?.url || GITHUB_DEVICE_LOGIN_URL
    openUrlInNewWindow(url, pushToast, t)
  }, [pushToast, t])
  const copyGithubDeviceLogin = useCallback(async () => {
    const code = githubDeviceLoginRef.current?.code
    if (!code) return
    const result = await writeClipboardText(code)
    if (!result.copied) {
      pushToast({ type: 'error', message: t('clipboard.copyFailed') })
      return
    }
    pushToast({
      type: result.unavailable ? 'info' : 'success',
      message: result.unavailable ? t('githubAuth.copiedInApp') : t('githubAuth.copied'),
    })
  }, [pushToast, t])
  const syncGithubDeviceLogin = useCallback(() => {
    if (githubAuthLoggedInRef.current !== false) {
      if (githubAuthLoggedInRef.current === true && githubDeviceLoginRef.current) setGithubDeviceLoginState(null)
      return
    }
    const detected = extractGithubDeviceLogin(githubDeviceLoginBufferRef.current)
    if (!detected) return
    if (detected.code === githubDeviceLoginDismissedRef.current && githubDeviceLoginRef.current?.code !== detected.code)
      return
    const current = githubDeviceLoginRef.current
    if (current?.code === detected.code && current.url === detected.url) return
    githubDeviceLoginDismissedRef.current = ''
    setGithubDeviceLoginState(detected)
  }, [setGithubDeviceLoginState])
  const updateGithubDeviceLogin = useCallback(
    (raw: string) => {
      const normalized = normalizeTerminalText(raw)
      if (!normalized) return
      githubDeviceLoginBufferRef.current = (githubDeviceLoginBufferRef.current + normalized).slice(-4096)
      syncGithubDeviceLogin()
    },
    [syncGithubDeviceLogin],
  )
  useEffect(() => {
    githubDeviceLoginBufferRef.current = ''
    githubDeviceLoginDismissedRef.current = ''
    githubAuthLoggedInRef.current = null
    setGithubDeviceLoginState(null)
  }, [activeHostId, sessionName, setGithubDeviceLoginState])
  useEffect(() => {
    let disposed = false
    const hostId = activeHostId || 'local'
    githubAuthLoggedInRef.current = null
    void api.hosts
      .githubAuthStatus(hostId)
      .then((status) => {
        if (disposed) return
        githubAuthLoggedInRef.current = status.ok ? status.loggedIn : null
        syncGithubDeviceLogin()
      })
      .catch(() => {
        if (disposed) return
        githubAuthLoggedInRef.current = null
        syncGithubDeviceLogin()
      })
    return () => {
      disposed = true
    }
  }, [activeHostId, syncGithubDeviceLogin])
  return {
    githubDeviceLogin,
    dismissGithubDeviceLogin,
    openGithubDeviceLogin,
    copyGithubDeviceLogin,
    updateGithubDeviceLogin,
  }
}
