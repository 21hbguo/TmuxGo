'use client'

import { useState, useEffect, useRef } from 'react'
import { AuditLog } from './AuditLog'
import { ConfirmDialog } from './ConfirmDialog'
import { setImmersiveFullscreenMode, usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useSessionContinuity } from '@/hooks/useSessionContinuity'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useClipboard } from '@/hooks/useClipboard'
import { useAppVersion } from '@/hooks/useAppVersion'
import { APP_BUILD_ID, APP_NAME, APP_VERSION } from '@/lib/app-version'
import { api, type ShareLink } from '@/lib/api'
import {
  changePassword,
  listAuthSessions,
  revokeAuthSession,
  revokeOtherAuthSessions,
  type AuthSession,
} from '@/lib/auth'
import { parseSessionName } from '@/lib/session-id'
import type { SessionArchive, SessionArchiveSummary } from '@/types'
import {
  useHosts,
  useRestartRebuild,
  useRestartRebuildStatus,
  useAppUpdateStatus,
  useAppUpdateTask,
  useCheckAppUpdate,
  useStartAppUpdate,
} from '@/hooks/useApi'
import { PluginSettings } from './PluginSettings'
import { SystemHealthPanel } from './SystemHealthPanel'
import { Button } from './Button'
import { Chip } from './Chip'

interface SettingsProps {
  onClose: () => void
}

/** 主题卡 mini 预览：bg 底色 + accent 色点 + 文本条，配色与各主题 css var 对应 */
const THEME_PREVIEW: Record<string, { bg: string; accent: string; fg: string }> = {
  dark: { bg: '#0c0d0f', accent: '#0a84ff', fg: '#f5f5f7' },
  light: { bg: '#f8f9fb', accent: '#005ac8', fg: '#1c1c1e' },
  'high-contrast': { bg: '#000000', accent: '#00ffff', fg: '#ffffff' },
  dracula: { bg: '#282a36', accent: '#bd93f9', fg: '#f8f8f2' },
  nord: { bg: '#3b4252', accent: '#98d0e0', fg: '#eceff4' },
  catppuccin: { bg: '#11111b', accent: '#89b4fa', fg: '#cdd6f4' },
  sage: { bg: '#1a2b23', accent: '#5ba882', fg: '#e0ebe4' },
}

export function Settings({ onClose }: SettingsProps) {
  const { preferences, updatePreferences, resetPreferences } = usePreferences()
  const { sessionContinuity, updateSessionContinuity } = useSessionContinuity()
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const { copy } = useClipboard()
  const [activeTab, setActiveTab] = useState<
    'general' | 'appearance' | 'connection' | 'security' | 'session' | 'plugins' | 'performance' | 'about'
  >('general')
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [authSessions, setAuthSessions] = useState<AuthSession[]>([])
  const [currentAuthSessionId, setCurrentAuthSessionId] = useState('')
  const [authSessionsLoading, setAuthSessionsLoading] = useState(false)
  const [authActionMessage, setAuthActionMessage] = useState('')
  const [currentPasswordDraft, setCurrentPasswordDraft] = useState('')
  const [newPasswordDraft, setNewPasswordDraft] = useState('')
  const [passwordChanging, setPasswordChanging] = useState(false)
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([])
  const [shareHostIdDraft, setShareHostIdDraft] = useState(activeHostId || 'local')
  const [shareSessionNameDraft, setShareSessionNameDraft] = useState(
    parseSessionName(activeHostId || 'local', activeSessionId || ''),
  )
  const [shareExpiresInMinutesDraft, setShareExpiresInMinutesDraft] = useState('60')
  const [shareLoading, setShareLoading] = useState(false)
  const [shareCreating, setShareCreating] = useState(false)
  const [shareActionMessage, setShareActionMessage] = useState('')
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [archives, setArchives] = useState<SessionArchiveSummary[]>([])
  const [archiveDetail, setArchiveDetail] = useState<SessionArchive | null>(null)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const { data: hosts = [] } = useHosts()
  const restartRebuild = useRestartRebuild()
  const {
    data: appVersionData,
    isLoading: appVersionLoading,
    error: appVersionError,
  } = useAppVersion(activeTab === 'about')
  const appUpdateQuery = useAppUpdateStatus(activeTab === 'about')
  const updateTaskQuery = useAppUpdateTask(activeTab === 'about')
  const checkAppUpdate = useCheckAppUpdate()
  const startAppUpdate = useStartAppUpdate()
  const updateInfo = appUpdateQuery.data
  const updateTask = updateTaskQuery.data || updateInfo?.task || null
  const updateTaskRunning = updateTask?.status === 'running' || startAppUpdate.isPending
  const updateChecking = checkAppUpdate.isPending || appUpdateQuery.isLoading
  const deployedNewer = !!appVersionData?.buildId && appVersionData.buildId !== APP_BUILD_ID
  const updateAvailable = (updateInfo?.available ?? false) || deployedNewer
  const latestRef =
    updateInfo?.latest ||
    (appVersionData ? { version: appVersionData.version, buildId: appVersionData.buildId, commit: '' } : null)
  const restartStatusQuery = useRestartRebuildStatus(activeTab === 'about')
  const [terminalPaddingDraft, setTerminalPaddingDraft] = useState(preferences.terminalPadding)
  const [uploadRateLimitDraft, setUploadRateLimitDraft] = useState(preferences.uploadRateLimitKBps)
  const [downloadRateLimitDraft, setDownloadRateLimitDraft] = useState(preferences.downloadRateLimitKBps)
  const fontSizeLabel = Number.isInteger(preferences.fontSize)
    ? `${preferences.fontSize}`
    : preferences.fontSize.toFixed(1)
  const aboutStatus = updateTaskRunning
    ? t('settings.updateRunning')
    : updateInfo?.error || (appVersionError && !updateInfo)
      ? t('settings.aboutLoadFailed')
      : updateChecking && !updateInfo && !appVersionData
        ? t('settings.aboutChecking')
        : updateAvailable
          ? updateInfo?.behindBy
            ? t('settings.aboutUpdateBehind', { count: updateInfo.behindBy })
            : t('settings.aboutUpdateAvailable')
          : t('settings.aboutUpdateCurrent')
  const restartStatus = restartStatusQuery.data || {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    summaryLines: [],
    exitCode: null,
    errorMessage: null,
  }
  const restartRunning = restartStatus.status === 'running' || restartRebuild.isPending
  useEffect(() => {
    setTerminalPaddingDraft(preferences.terminalPadding)
    setUploadRateLimitDraft(preferences.uploadRateLimitKBps)
    setDownloadRateLimitDraft(preferences.downloadRateLimitKBps)
  }, [preferences.terminalPadding, preferences.uploadRateLimitKBps, preferences.downloadRateLimitKBps, activeTab])
  useEffect(() => {
    if (activeTab !== 'about' || restartStatus.status !== 'running') return
    const timer = window.setInterval(() => {
      void restartStatusQuery.refetch()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [activeTab, restartStatus.status, restartStatusQuery])
  const prevUpdateStatusRef = useRef<string | null>(null)
  useEffect(() => {
    const current = updateTask?.status || null
    const prev = prevUpdateStatusRef.current
    prevUpdateStatusRef.current = current
    if (prev !== 'running' || !current || current === 'running') return
    if (current === 'error') {
      pushToast({ type: 'error', message: updateTask?.errorMessage || t('settings.updateFailed') })
      return
    }
    if (current !== 'success') return
    void (async () => {
      try {
        const result = await appUpdateQuery.refetch()
        const commit = result.data?.current?.commit || result.data?.latest?.commit || ''
        if (commit && !APP_BUILD_ID.endsWith(commit)) {
          pushToast({ type: 'success', message: t('settings.updateReloading'), durationMs: 4000 })
          window.setTimeout(() => window.location.reload(), 2000)
          return
        }
      } catch {}
      pushToast({ type: 'success', message: t('settings.updateSuccess') })
    })()
  }, [updateTask?.status, updateTask?.errorMessage])

  const tabs = [
    { id: 'general' as const, label: t('settings.general') },
    { id: 'appearance' as const, label: t('settings.appearance') },
    { id: 'connection' as const, label: t('settings.connection') },
    { id: 'security' as const, label: t('settings.security') },
    { id: 'session' as const, label: t('settings.session') },
    { id: 'plugins' as const, label: t('settings.plugins') },
    { id: 'performance' as const, label: t('settings.performance') },
    { id: 'about' as const, label: t('settings.about') },
  ]

  const commitTerminalPadding = () => {
    if (terminalPaddingDraft === preferences.terminalPadding) return
    updatePreferences({ terminalPadding: terminalPaddingDraft })
  }
  const commitUploadRateLimit = () => {
    if (uploadRateLimitDraft === preferences.uploadRateLimitKBps) return
    updatePreferences({ uploadRateLimitKBps: uploadRateLimitDraft })
  }
  const commitDownloadRateLimit = () => {
    if (downloadRateLimitDraft === preferences.downloadRateLimitKBps) return
    updatePreferences({ downloadRateLimitKBps: downloadRateLimitDraft })
  }
  const copyVersionInfo = async () => {
    const text = [
      `${t('settings.aboutAppName')}: ${APP_NAME}`,
      `${t('settings.aboutCurrentVersion')}: ${APP_VERSION}`,
      `${t('settings.aboutCurrentBuild')}: ${APP_BUILD_ID}`,
      `${t('settings.aboutUpdateStatus')}: ${aboutStatus}`,
      `${t('settings.aboutLatestVersion')}: ${latestRef?.version || '-'}`,
      `${t('settings.aboutLatestBuild')}: ${latestRef?.buildId || '-'}`,
    ].join('\n')
    const copied = await copy(text)
    if (!copied) {
      pushToast({ type: 'error', message: t('clipboard.copyFailed') })
      return
    }
    pushToast({ type: 'success', message: t('settings.aboutCopied') })
  }
  const loadAuthSessions = async () => {
    setAuthSessionsLoading(true)
    try {
      const result = await listAuthSessions()
      setAuthSessions(result.sessions)
      setCurrentAuthSessionId(result.currentSessionId)
    } catch (err: any) {
      setAuthActionMessage(err?.message || t('settings.securityLoadFailed'))
    } finally {
      setAuthSessionsLoading(false)
    }
  }
  const loadShareLinks = async () => {
    setShareLoading(true)
    try {
      const result = await api.shares.list()
      setShareLinks(result.links)
    } catch (err: any) {
      setShareActionMessage(err?.message || t('settings.shareLoadFailed'))
    } finally {
      setShareLoading(false)
    }
  }
  useEffect(() => {
    if (activeTab !== 'security') return
    void loadAuthSessions()
    void loadShareLinks()
  }, [activeTab])
  const revokeSession = async (sessionId: string) => {
    setAuthActionMessage('')
    try {
      await revokeAuthSession(sessionId)
      setAuthActionMessage(t('settings.securityDeviceRevoked'))
      await loadAuthSessions()
    } catch (err: any) {
      setAuthActionMessage(err?.message || t('settings.securityActionFailed'))
    }
  }
  const revokeOtherSessions = async () => {
    setAuthActionMessage('')
    try {
      const result = await revokeOtherAuthSessions()
      setAuthActionMessage(t('settings.securityOtherRevoked', { count: result.deleted }))
      await loadAuthSessions()
    } catch (err: any) {
      setAuthActionMessage(err?.message || t('settings.securityActionFailed'))
    }
  }
  const updateAccountPassword = async () => {
    if (passwordChanging) return
    setPasswordChanging(true)
    setAuthActionMessage('')
    try {
      await changePassword(currentPasswordDraft, newPasswordDraft)
    } catch (err: any) {
      setAuthActionMessage(err?.message || t('settings.securityPasswordFailed'))
      setPasswordChanging(false)
    }
  }
  const createShareLink = async () => {
    if (shareCreating || !shareSessionNameDraft.trim()) return
    setShareCreating(true)
    setShareActionMessage('')
    try {
      const result = await api.shares.create(
        shareHostIdDraft,
        shareSessionNameDraft.trim(),
        Number(shareExpiresInMinutesDraft),
      )
      const copied = await copy(`${window.location.origin}/share#token=${result.token}`)
      setShareActionMessage(copied ? t('settings.shareCopied') : t('settings.shareCreated'))
      await loadShareLinks()
    } catch (err: any) {
      setShareActionMessage(err?.message || t('settings.shareActionFailed'))
    } finally {
      setShareCreating(false)
    }
  }
  const revokeShareLink = async (shareId: string) => {
    setShareActionMessage('')
    try {
      await api.shares.revoke(shareId)
      setShareActionMessage(t('settings.shareRevoked'))
      await loadShareLinks()
    } catch (err: any) {
      setShareActionMessage(err?.message || t('settings.shareActionFailed'))
    }
  }
  const loadArchives = async () => {
    setArchiveLoading(true)
    try {
      const data = await api.sessionArchives.list(activeHostId || 'local')
      setArchives(data.archives)
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setArchiveLoading(false)
  }
  const openArchiveDialog = () => {
    setArchiveDialogOpen(true)
    setArchiveDetail(null)
    void loadArchives()
  }
  const openArchive = async (archiveId: string) => {
    setArchiveLoading(true)
    try {
      setArchiveDetail(await api.sessionArchives.get(activeHostId || 'local', archiveId))
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setArchiveLoading(false)
  }
  const deleteArchive = async (archiveId: string) => {
    try {
      await api.sessionArchives.remove(activeHostId || 'local', archiveId)
      if (archiveDetail?.id === archiveId) setArchiveDetail(null)
      await loadArchives()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
  }
  const triggerRestartRebuild = async () => {
    try {
      const next = await restartRebuild.mutateAsync()
      setRestartConfirmOpen(false)
      if (next.status === 'success') pushToast({ type: 'success', message: t('settings.restartSuccess') })
      if (next.status === 'error')
        pushToast({ type: 'error', message: next.errorMessage || t('settings.restartFailed') })
      void restartStatusQuery.refetch()
    } catch (err: any) {
      pushToast({ type: 'error', message: err?.message || t('settings.restartFailed') })
    }
  }
  const restartStatusLabel =
    restartStatus.status === 'running'
      ? t('settings.restartStatusRunning')
      : restartStatus.status === 'success'
        ? t('settings.restartStatusSuccess')
        : restartStatus.status === 'error'
          ? t('settings.restartStatusFailed')
          : restartStatus.status === 'cancelled'
            ? t('tasks.status.cancelled')
            : t('settings.restartStatusIdle')
  const updateTaskStatusLabel = !updateTask
    ? t('settings.restartStatusIdle')
    : updateTask.status === 'running'
      ? t('settings.restartStatusRunning')
      : updateTask.status === 'success'
        ? t('settings.restartStatusSuccess')
        : updateTask.status === 'error'
          ? t('settings.restartStatusFailed')
          : updateTask.status === 'cancelled'
            ? t('tasks.status.cancelled')
            : t('settings.restartStatusIdle')
  const triggerCheckUpdate = async () => {
    try {
      await checkAppUpdate.mutateAsync()
    } catch (err: any) {
      pushToast({ type: 'error', message: err?.message || t('settings.updateCheckFailed') })
    }
  }
  const triggerAppUpdate = async () => {
    setUpdateConfirmOpen(false)
    try {
      await startAppUpdate.mutateAsync()
      void updateTaskQuery.refetch()
    } catch (err: any) {
      pushToast({ type: 'error', message: err?.message || t('settings.updateFailed') })
    }
  }

  const toggleImmersiveFullscreen = async () => {
    try {
      await setImmersiveFullscreenMode(!preferences.immersiveFullscreen)
    } catch {
      pushToast({ type: 'error', message: t('settings.immersiveFullscreenFailed') })
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center tmuxgo-scrim p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      onClick={onClose}
    >
      <div
        className="tmuxgo-glass tmuxgo-glass-dialog flex h-[70vh] md:h-[600px] w-full max-w-[700px] flex-col overflow-hidden rounded-apple border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 p-4 border-b border-[var(--line)] flex items-center justify-between">
          <h2 className="text-text-1 text-lg font-medium">{t('settings.title')}</h2>
          <Button variant="ghost" size="sm" aria-label="close" onClick={onClose}>
            ✕
          </Button>
        </div>

        <div className="tmuxgo-scrollbar shrink-0 flex overflow-x-auto border-b border-[var(--line)]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm ${
                activeTab === tab.id ? 'text-text-1 border-b border-accent' : 'text-text-2 hover:text-text-1'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-6">
          {activeTab === 'general' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.language')}</h3>
                <select
                  value={preferences.language}
                  onChange={(e) => updatePreferences({ language: e.target.value as 'zh' | 'en' })}
                  className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-2 text-sm"
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.reconnect')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.autoReconnect')}</span>
                    <button
                      onClick={() => updatePreferences({ autoReconnect: !preferences.autoReconnect })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.autoReconnect ? 'bg-accent' : 'bg-bg-2'
                      }`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.autoReconnect ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.reconnectInterval')}</span>
                    <span className="text-text-1 text-sm">{preferences.reconnectInterval / 1000}s</span>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.notifications')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.agentNotificationsEnabled')}</span>
                    <button
                      onClick={() =>
                        updatePreferences({ agentNotificationsEnabled: !preferences.agentNotificationsEnabled })
                      }
                      className={`w-10 h-6 rounded-full relative ${preferences.agentNotificationsEnabled ? 'bg-accent' : 'bg-bg-2'}`}
                      aria-label={t('settings.agentNotificationsEnabled')}
                      aria-pressed={preferences.agentNotificationsEnabled}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${preferences.agentNotificationsEnabled ? 'right-1' : 'left-1'}`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.agentNotificationDuration')}</span>
                    <select
                      value={preferences.agentNotificationDurationMs}
                      onChange={(event) =>
                        updatePreferences({ agentNotificationDurationMs: Number(event.target.value) })
                      }
                      disabled={!preferences.agentNotificationsEnabled}
                      className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t('settings.agentNotificationDuration')}
                    >
                      {[3000, 5000, 10000, 30000, 60000].map((duration) => (
                        <option key={duration} value={duration}>
                          {t('settings.seconds', { count: duration / 1000 })}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--line)]">
                <div className="min-w-0 pr-3">
                  <div className="text-text-2 text-sm">{t('settings.forceRefresh')}</div>
                  <div className="mt-1 text-caption text-text-3">{t('settings.forceRefreshDesc')}</div>
                </div>
                <Button size="sm" onClick={() => window.location.reload()}>
                  {t('settings.forceRefresh')}
                </Button>
              </div>

              <div className="pt-4 border-t border-[var(--line)]">
                <Button size="sm" onClick={resetPreferences}>
                  {t('settings.resetDefaults')}
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.theme')}</h3>
                <div className="grid grid-cols-3 gap-3">
                  {(['dark', 'light', 'high-contrast', 'dracula', 'nord', 'catppuccin', 'sage'] as const).map(
                    (theme) => {
                      const key = theme === 'high-contrast' ? 'highContrast' : theme
                      const preview = THEME_PREVIEW[theme]
                      return (
                        <button
                          key={theme}
                          onClick={() => updatePreferences({ theme })}
                          className={`p-3 bg-bg-2 rounded-apple border-2 ${
                            preferences.theme === theme ? 'border-accent' : 'border-transparent'
                          }`}
                        >
                          <div
                            className="mb-2 flex h-9 items-end gap-1 rounded-md border border-[var(--line)] p-1.5"
                            style={{ background: preview.bg }}
                            aria-hidden="true"
                          >
                            <span className="h-1 w-6 rounded-full" style={{ background: preview.accent }} />
                            <span className="h-1 w-4 rounded-full opacity-60" style={{ background: preview.fg }} />
                          </div>
                          <div className="text-text-1 text-sm">{t(`settings.theme.${key}` as any)}</div>
                        </button>
                      )
                    },
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="min-w-0 pr-3">
                    <div className="text-text-2 text-sm">{t('settings.immersiveFullscreen')}</div>
                    <div className="mt-1 text-caption text-text-3">{t('settings.immersiveFullscreenDesc')}</div>
                  </div>
                  <button
                    onClick={() => void toggleImmersiveFullscreen()}
                    className={`w-10 h-6 shrink-0 rounded-full relative ${preferences.immersiveFullscreen ? 'bg-accent' : 'bg-bg-2'}`}
                    aria-label={t('settings.immersiveFullscreen')}
                    aria-pressed={preferences.immersiveFullscreen}
                  >
                    <div
                      className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${preferences.immersiveFullscreen ? 'right-1' : 'left-1'}`}
                    />
                  </button>
                </div>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.layout')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.sidebarPosition')}</span>
                    <div className="tmuxgo-segment">
                      {(['left', 'right'] as const).map((pos) => (
                        <button
                          key={pos}
                          onClick={() => updatePreferences({ sidebarPosition: pos })}
                          aria-pressed={preferences.sidebarPosition === pos}
                          className="tmuxgo-segment__item"
                        >
                          {t(`settings.sidebarPosition.${pos}` as any)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.showStatusBar')}</span>
                    <button
                      onClick={() => updatePreferences({ showStatusBar: !preferences.showStatusBar })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.showStatusBar ? 'bg-accent' : 'bg-bg-2'
                      }`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.showStatusBar ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.showQuickActions')}</span>
                    <button
                      onClick={() => updatePreferences({ showQuickActions: !preferences.showQuickActions })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.showQuickActions ? 'bg-accent' : 'bg-bg-2'
                      }`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.showQuickActions ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.terminal')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.fontSize')}</span>
                    <div className="flex items-center gap-2">
                      <Chip
                        onClick={() =>
                          updatePreferences({ fontSize: Math.max(8, Math.round((preferences.fontSize - 1) * 10) / 10) })
                        }
                      >
                        -
                      </Chip>
                      <span className="text-text-1 text-sm w-12 text-center">{fontSizeLabel}px</span>
                      <Chip
                        onClick={() =>
                          updatePreferences({
                            fontSize: Math.min(20, Math.round((preferences.fontSize + 1) * 10) / 10),
                          })
                        }
                      >
                        +
                      </Chip>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.cursorBlink')}</span>
                    <button
                      onClick={() => updatePreferences({ cursorBlink: !preferences.cursorBlink })}
                      className={`w-10 h-6 rounded-full relative ${preferences.cursorBlink ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.cursorBlink ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.terminalPadding')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={20}
                        value={terminalPaddingDraft}
                        onChange={(e) => {
                          const next = Number(e.target.value)
                          setTerminalPaddingDraft(next)
                          updatePreferences({ terminalPadding: next })
                        }}
                        className="w-24 accent-accent"
                      />
                      <span className="text-text-1 text-sm w-8 text-center">{terminalPaddingDraft}px</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'connection' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.transfer')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.uploadRateLimit')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={50}
                        step={50}
                        max={10240}
                        value={uploadRateLimitDraft}
                        onChange={(e) => setUploadRateLimitDraft(Number(e.target.value))}
                        onMouseUp={commitUploadRateLimit}
                        onTouchEnd={commitUploadRateLimit}
                        onKeyUp={commitUploadRateLimit}
                        className="w-24 accent-accent"
                      />
                      <span className="text-text-1 text-sm w-16 text-center">{uploadRateLimitDraft}KB/s</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.downloadRateLimit')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={50}
                        step={50}
                        max={10240}
                        value={downloadRateLimitDraft}
                        onChange={(e) => setDownloadRateLimitDraft(Number(e.target.value))}
                        onMouseUp={commitDownloadRateLimit}
                        onTouchEnd={commitDownloadRateLimit}
                        onKeyUp={commitDownloadRateLimit}
                        className="w-24 accent-accent"
                      />
                      <span className="text-text-1 text-sm w-16 text-center">{downloadRateLimitDraft}KB/s</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="space-y-6">
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="text-sm font-medium text-text-1">{t('settings.securityPasswordTitle')}</div>
                <div className="mt-1 text-xs text-text-3">{t('settings.securityPasswordDesc')}</div>
                <div className="mt-4 space-y-2">
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={currentPasswordDraft}
                    onChange={(event) => setCurrentPasswordDraft(event.target.value)}
                    placeholder={t('auth.currentPassword')}
                    className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    value={newPasswordDraft}
                    onChange={(event) => setNewPasswordDraft(event.target.value)}
                    placeholder={t('auth.newPassword')}
                    className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={passwordChanging || !currentPasswordDraft || newPasswordDraft.length < 8}
                    onClick={() => void updateAccountPassword()}
                  >
                    {passwordChanging ? t('auth.passwordChanging') : t('auth.passwordChange')}
                  </Button>
                </div>
              </div>
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-1">{t('settings.securityDevicesTitle')}</div>
                    <div className="mt-1 text-xs text-text-3">{t('settings.securityDevicesDesc')}</div>
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={
                      authSessionsLoading || !authSessions.some((session) => session.id !== currentAuthSessionId)
                    }
                    onClick={() => void revokeOtherSessions()}
                  >
                    {t('settings.securityRevokeOthers')}
                  </Button>
                </div>
                {authSessionsLoading && <div className="mt-4 text-sm text-text-3">{t('common.loading')}</div>}
                {!authSessionsLoading && !authSessions.length && (
                  <div className="mt-4 text-sm text-text-3">{t('settings.securityNoDevices')}</div>
                )}
                {!authSessionsLoading && authSessions.length > 0 && (
                  <div className="mt-4 divide-y divide-[var(--line)] rounded-apple border border-[var(--line)]">
                    {authSessions.map((session) => (
                      <div key={session.id} className="flex items-start gap-3 px-3 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-text-1">
                              {session.id === currentAuthSessionId
                                ? t('settings.securityCurrentDevice')
                                : t('settings.securityDevice')}
                            </span>
                            <span className="text-xs text-text-3">{session.ip || '-'}</span>
                          </div>
                          <div className="mt-1 break-words text-xs text-text-3">
                            {session.userAgent || t('settings.securityUnknownDevice')}
                          </div>
                          <div className="mt-1 text-xs text-text-3">
                            {t('settings.securityCreatedAt', { value: new Date(session.createdAt).toLocaleString() })} ·{' '}
                            {t('settings.securityLastUsedAt', { value: new Date(session.lastUsedAt).toLocaleString() })}{' '}
                            · {t('settings.securityExpiresAt', { value: new Date(session.expiresAt).toLocaleString() })}
                          </div>
                        </div>
                        {session.id !== currentAuthSessionId && (
                          <Button size="sm" className="shrink-0" onClick={() => void revokeSession(session.id)}>
                            {t('settings.securityRevoke')}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="text-sm font-medium text-text-1">{t('settings.shareTitle')}</div>
                <div className="mt-1 text-xs text-text-3">{t('settings.shareDesc')}</div>
                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  <select
                    aria-label={t('settings.shareHost')}
                    value={shareHostIdDraft}
                    onChange={(event) => setShareHostIdDraft(event.target.value)}
                    className="tmuxgo-control tmuxgo-input rounded-apple px-2 py-1.5 text-sm"
                  >
                    <option value="local">{t('settings.shareLocalHost')}</option>
                    {hosts.map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.name || host.id}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={t('settings.shareSession')}
                    value={shareSessionNameDraft}
                    onChange={(event) => setShareSessionNameDraft(event.target.value)}
                    placeholder={t('settings.shareSession')}
                    className="tmuxgo-control tmuxgo-input rounded-apple px-2 py-1.5 text-sm"
                  />
                  <select
                    aria-label={t('settings.shareExpires')}
                    value={shareExpiresInMinutesDraft}
                    onChange={(event) => setShareExpiresInMinutesDraft(event.target.value)}
                    className="tmuxgo-control tmuxgo-input rounded-apple px-2 py-1.5 text-sm"
                  >
                    <option value="15">{t('settings.shareMinutes', { value: 15 })}</option>
                    <option value="60">{t('settings.shareHours', { value: 1 })}</option>
                    <option value="240">{t('settings.shareHours', { value: 4 })}</option>
                    <option value="1440">{t('settings.shareDays', { value: 1 })}</option>
                  </select>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={shareCreating || !shareSessionNameDraft.trim()}
                    onClick={() => void createShareLink()}
                  >
                    {shareCreating ? t('common.loading') : t('settings.shareCreate')}
                  </Button>
                </div>
                {shareLoading && <div className="mt-4 text-sm text-text-3">{t('common.loading')}</div>}
                {!shareLoading && !shareLinks.length && (
                  <div className="mt-4 text-sm text-text-3">{t('settings.shareEmpty')}</div>
                )}
                {!shareLoading && shareLinks.length > 0 && (
                  <div className="mt-4 divide-y divide-[var(--line)] rounded-apple border border-[var(--line)]">
                    {shareLinks.map((link) => (
                      <div key={link.id} className="flex items-center gap-3 px-3 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-text-1">
                            {link.hostId}/{link.sessionName}
                          </div>
                          <div className="mt-1 text-xs text-text-3">
                            {link.revokedAt
                              ? t('settings.shareRevokedAt', { value: new Date(link.revokedAt).toLocaleString() })
                              : t('settings.shareExpiresAt', { value: new Date(link.expiresAt).toLocaleString() })}
                          </div>
                        </div>
                        {!link.revokedAt && (
                          <Button size="sm" className="shrink-0" onClick={() => void revokeShareLink(link.id)}>
                            {t('settings.shareRevoke')}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {authActionMessage && <div className="text-sm text-danger">{authActionMessage}</div>}
              {shareActionMessage && <div className="text-sm text-danger">{shareActionMessage}</div>}
            </div>
          )}

          {activeTab === 'session' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.sessionContinuity')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.sessionContinuityEnabled')}</span>
                    <button
                      onClick={() => updateSessionContinuity({ enabled: !sessionContinuity.enabled })}
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.enabled ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.enabled ? 'right-1' : 'left-1'}`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.resumeOnReconnect')}</span>
                    <button
                      onClick={() =>
                        updateSessionContinuity({ resumeOnReconnect: !sessionContinuity.resumeOnReconnect })
                      }
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.resumeOnReconnect ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.resumeOnReconnect ? 'right-1' : 'left-1'}`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.resumeOnNewDevice')}</span>
                    <button
                      onClick={() =>
                        updateSessionContinuity({ resumeOnNewDevice: !sessionContinuity.resumeOnNewDevice })
                      }
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.resumeOnNewDevice ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.resumeOnNewDevice ? 'right-1' : 'left-1'}`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.archiveEnabled')}</span>
                    <button
                      onClick={() =>
                        updateSessionContinuity({
                          archive: {
                            ...sessionContinuity.archive,
                            enabled: !sessionContinuity.archive.enabled,
                            captureMode: sessionContinuity.archive.enabled
                              ? 'none'
                              : sessionContinuity.archive.captureMode === 'none'
                                ? 'visible'
                                : sessionContinuity.archive.captureMode,
                          },
                        })
                      }
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.archive.enabled ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.archive.enabled ? 'right-1' : 'left-1'}`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.archiveCaptureMode')}</span>
                    <select
                      value={
                        sessionContinuity.archive.captureMode === 'none'
                          ? 'visible'
                          : sessionContinuity.archive.captureMode
                      }
                      disabled={!sessionContinuity.archive.enabled}
                      onChange={(event) =>
                        updateSessionContinuity({
                          archive: {
                            ...sessionContinuity.archive,
                            captureMode: event.target.value as 'visible' | 'history',
                          },
                        })
                      }
                      className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      <option value="visible">{t('settings.archiveVisible')}</option>
                      <option value="history">{t('settings.archiveHistory')}</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.archiveMaxSize')}</span>
                    <select
                      value={sessionContinuity.archive.maxBytesPerSession}
                      disabled={!sessionContinuity.archive.enabled}
                      onChange={(event) =>
                        updateSessionContinuity({
                          archive: { ...sessionContinuity.archive, maxBytesPerSession: Number(event.target.value) },
                        })
                      }
                      className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      <option value={262144}>256 KB</option>
                      <option value={1048576}>1 MB</option>
                      <option value={4194304}>4 MB</option>
                      <option value={16777216}>16 MB</option>
                      <option value={33554432}>32 MB</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.archiveRetention')}</span>
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={sessionContinuity.archive.retentionDays}
                      disabled={!sessionContinuity.archive.enabled}
                      onChange={(event) =>
                        updateSessionContinuity({
                          archive: {
                            ...sessionContinuity.archive,
                            retentionDays: Math.max(1, Math.min(3650, Number(event.target.value) || 1)),
                          },
                        })
                      }
                      className="tmuxgo-control tmuxgo-input w-20 rounded-apple px-2 py-1.5 text-right text-sm disabled:opacity-50"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.resumePointCount')}</span>
                    <span className="text-text-1 text-sm">{sessionContinuity.resumePoints.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.maxResumePoints')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={1}
                        max={100}
                        value={sessionContinuity.maxResumePoints}
                        onChange={(event) => updateSessionContinuity({ maxResumePoints: Number(event.target.value) })}
                        className="w-24 accent-accent"
                      />
                      <span className="text-text-1 text-sm w-8 text-center">{sessionContinuity.maxResumePoints}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-end">
                    <Button size="sm" className="mr-2" onClick={openArchiveDialog}>
                      {t('settings.viewArchives')}
                    </Button>
                    <Button size="sm" onClick={() => updateSessionContinuity({ resumePoints: [] })}>
                      {t('settings.clearResumePoints')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'plugins' && <PluginSettings />}

          {activeTab === 'performance' && <SystemHealthPanel />}

          {activeTab === 'about' && (
            <div className="space-y-4">
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="text-base font-medium text-text-1">{APP_NAME}</div>
                <div className="mt-1 text-xs text-text-3">{t('settings.aboutDesc')}</div>
              </div>
              <div className="rounded-apple border border-[var(--line)]">
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-text-2">{t('settings.aboutCurrentVersion')}</span>
                  <span className="text-sm text-text-1">{APP_VERSION}</span>
                </div>
                <div className="border-t border-[var(--line)] flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-text-2">{t('settings.aboutCurrentBuild')}</span>
                  <span className="text-sm text-text-1">{APP_BUILD_ID}</span>
                </div>
                <div className="border-t border-[var(--line)] flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-text-2">{t('settings.aboutLatestVersion')}</span>
                  <span className="text-sm text-text-1">
                    {updateChecking && !latestRef ? '...' : latestRef?.version || '-'}
                  </span>
                </div>
                <div className="border-t border-[var(--line)] flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-text-2">{t('settings.aboutLatestBuild')}</span>
                  <span className="text-sm text-text-1">
                    {updateChecking && !latestRef ? '...' : latestRef?.buildId || '-'}
                  </span>
                </div>
                <div className="border-t border-[var(--line)] flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-text-2">{t('settings.aboutUpdateStatus')}</span>
                  <span
                    className={`text-sm ${updateTaskRunning || updateAvailable ? 'text-warn' : updateInfo?.error || appVersionError ? 'text-danger' : 'text-accent-2'}`}
                  >
                    {aboutStatus}
                  </span>
                </div>
              </div>
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-1">{t('settings.updateTitle')}</div>
                    <div className="mt-1 text-xs text-text-3">{t('settings.updateDesc')}</div>
                    {updateInfo?.dirty && <div className="mt-1 text-xs text-warn">{t('settings.updateDirty')}</div>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={updateChecking || updateTaskRunning}
                      onClick={() => void triggerCheckUpdate()}
                    >
                      {updateChecking ? t('settings.updateChecking') : t('settings.updateCheck')}
                    </Button>
                    <Button variant="primary" disabled={updateTaskRunning} onClick={() => setUpdateConfirmOpen(true)}>
                      {t('settings.updateAction')}
                    </Button>
                  </div>
                </div>
                {updateTask && (updateTask.status !== 'idle' || updateTask.summaryLines.length > 0) && (
                  <div className="mt-4 rounded-apple border border-[var(--line)] px-3 py-2">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm text-text-2">{t('settings.updateStatus')}</span>
                      <span
                        className={`text-sm ${updateTask.status === 'success' ? 'text-accent-2' : updateTask.status === 'error' || updateTask.status === 'cancelled' ? 'text-danger' : updateTask.status === 'running' ? 'text-warn' : 'text-text-1'}`}
                      >
                        {updateTaskStatusLabel}
                      </span>
                    </div>
                    {updateTask.summaryLines.length > 0 && (
                      <div className="mt-2 rounded-apple bg-bg-1 px-2 py-2 font-mono text-xs text-text-2">
                        {updateTask.summaryLines.map((line, index) => (
                          <div key={`${index}-${line}`}>{line}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-1">{t('settings.restartTitle')}</div>
                    <div className="mt-1 text-xs text-text-3">{t('settings.restartDesc')}</div>
                  </div>
                  <Button
                    variant="primary"
                    disabled={restartRunning}
                    className="shrink-0"
                    onClick={() => setRestartConfirmOpen(true)}
                  >
                    {t('settings.restartAction')}
                  </Button>
                </div>
                <div className="mt-4 rounded-apple border border-[var(--line)] px-3 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-text-2">{t('settings.restartStatus')}</span>
                    <span
                      className={`text-sm ${restartStatus.status === 'success' ? 'text-accent-2' : restartStatus.status === 'error' || restartStatus.status === 'cancelled' ? 'text-danger' : restartStatus.status === 'running' ? 'text-warn' : 'text-text-1'}`}
                    >
                      {restartStatusLabel}
                    </span>
                  </div>
                  {restartStatus.summaryLines.length > 0 && (
                    <div className="mt-2 rounded-apple bg-bg-1 px-2 py-2 font-mono text-xs text-text-2">
                      {restartStatus.summaryLines.map((line, index) => (
                        <div key={`${index}-${line}`}>{line}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {deployedNewer && <div className="text-xs text-text-3">{t('settings.aboutRefresh')}</div>}
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-1">{t('settings.auditLog')}</div>
                    <div className="mt-1 text-xs text-text-3">{t('settings.auditDesc')}</div>
                  </div>
                  <Button variant="primary" className="shrink-0" onClick={() => setShowAuditLog(true)}>
                    {t('settings.viewLog')}
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-end">
                <Button variant="primary" onClick={() => void copyVersionInfo()}>
                  {t('settings.aboutCopy')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {archiveDialogOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center tmuxgo-scrim-strong p-4"
          onClick={() => setArchiveDialogOpen(false)}
        >
          <div
            className="tmuxgo-glass tmuxgo-glass-dialog flex h-[75vh] w-full max-w-4xl flex-col overflow-hidden rounded-apple border"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
              <h3 className="text-base font-medium text-text-1">{t('settings.archives')}</h3>
              <Button variant="ghost" size="sm" aria-label="close" onClick={() => setArchiveDialogOpen(false)}>
                ✕
              </Button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_1fr]">
              <div className="tmuxgo-scrollbar overflow-y-auto border-b border-[var(--line)] md:border-b-0 md:border-r">
                {archiveLoading && !archives.length && (
                  <div className="p-4 text-sm text-text-3">{t('common.loading')}</div>
                )}
                {!archiveLoading && !archives.length && (
                  <div className="p-4 text-sm text-text-3">{t('settings.archiveEmpty')}</div>
                )}
                {archives.map((archive) => (
                  <div
                    key={archive.id}
                    className={`tmuxgo-list-row flex border-b border-[var(--line)] ${archiveDetail?.id === archive.id ? 'tmuxgo-list-row--active' : 'tmuxgo-list-row--hover'}`}
                  >
                    <button onClick={() => void openArchive(archive.id)} className="min-w-0 flex-1 p-3 text-left">
                      <div className="truncate text-sm text-text-1">{archive.sessionName}</div>
                      <div className="mt-1 text-xs text-text-3">
                        {new Date(archive.createdAt).toLocaleString()} · {archive.paneCount} ·{' '}
                        {Math.ceil(archive.size / 1024)} KB
                      </div>
                    </button>
                    <button
                      onClick={() => void deleteArchive(archive.id)}
                      className="w-10 text-text-3 hover:text-danger"
                      aria-label={t('settings.deleteArchive')}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="tmuxgo-scrollbar min-h-0 overflow-y-auto p-4">
                {!archiveDetail && (
                  <div className="flex h-full items-center justify-center text-sm text-text-3">
                    {t('settings.selectArchive')}
                  </div>
                )}
                {archiveDetail && (
                  <div className="space-y-4">
                    <div>
                      <div className="text-base font-medium text-text-1">{archiveDetail.sessionName}</div>
                      <div className="mt-1 text-xs text-text-3">
                        {archiveDetail.captureMode === 'history'
                          ? t('settings.archiveHistory')
                          : t('settings.archiveVisible')}{' '}
                        · {new Date(archiveDetail.createdAt).toLocaleString()}
                      </div>
                    </div>
                    {archiveDetail.panes.map((pane) => (
                      <div key={pane.paneId}>
                        <div className="mb-1 text-xs text-text-3">
                          {pane.windowName} / {pane.title}
                        </div>
                        <pre className="overflow-x-auto whitespace-pre-wrap rounded-apple border border-[var(--line)] bg-bg-0 p-3 font-mono text-xs text-text-2">
                          {pane.data || t('settings.archiveNoOutput')}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={restartConfirmOpen}
        title={t('settings.restartConfirmTitle')}
        message={t('settings.restartConfirmMessage')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setRestartConfirmOpen(false)}
        onConfirm={() => void triggerRestartRebuild()}
      />
      <ConfirmDialog
        open={updateConfirmOpen}
        title={t('settings.updateConfirmTitle')}
        message={t('settings.updateConfirmMessage')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setUpdateConfirmOpen(false)}
        onConfirm={() => void triggerAppUpdate()}
      />
      {showAuditLog && <AuditLog onClose={() => setShowAuditLog(false)} />}
    </div>
  )
}
