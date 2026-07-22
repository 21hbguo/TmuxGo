'use client'

import { useState, useEffect } from 'react'
import { AuditLog } from './AuditLog'
import { ConfirmDialog } from './ConfirmDialog'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useSessionContinuity } from '@/hooks/useSessionContinuity'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useClipboard } from '@/hooks/useClipboard'
import { useAppVersion } from '@/hooks/useAppVersion'
import { APP_BUILD_ID, APP_NAME, APP_VERSION } from '@/lib/app-version'
import { api } from '@/lib/api'
import type { SessionArchive, SessionArchiveSummary } from '@/types'
import { useCreateHost, useDeleteHost, useHosts, useRestartRebuild, useRestartRebuildStatus, useTestHost } from '@/hooks/useApi'
import { PluginSettings } from './PluginSettings'
import { Button } from './Button'
import { Chip } from './Chip'

interface SettingsProps {
  onClose: () => void
}

export function Settings({ onClose }: SettingsProps) {
  const { preferences, updatePreferences, resetPreferences } = usePreferences()
  const { sessionContinuity, updateSessionContinuity } = useSessionContinuity()
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const { copy } = useClipboard()
  const [activeTab, setActiveTab] = useState<'general' | 'appearance' | 'plugins' | 'audit' | 'about'>('general')
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [hostIdDraft, setHostIdDraft] = useState('')
  const [hostNameDraft, setHostNameDraft] = useState('')
  const [hostAddressDraft, setHostAddressDraft] = useState('')
  const [hostUserDraft, setHostUserDraft] = useState('')
  const [hostPortDraft, setHostPortDraft] = useState('22')
  const [hostPasswordDraft, setHostPasswordDraft] = useState('')
  const [hostDialogOpen, setHostDialogOpen] = useState(false)
  const [hostDialogMode, setHostDialogMode] = useState<'create' | 'edit'>('create')
  const [hostActionMessage, setHostActionMessage] = useState('')
  const [pendingDeleteHostId, setPendingDeleteHostId] = useState<string | null>(null)
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [archives, setArchives] = useState<SessionArchiveSummary[]>([])
  const [archiveDetail, setArchiveDetail] = useState<SessionArchive | null>(null)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const { data: hosts = [] } = useHosts()
  const createHost = useCreateHost()
  const deleteHost = useDeleteHost()
  const testHost = useTestHost()
  const restartRebuild = useRestartRebuild()
  const { data: appVersionData, isLoading: appVersionLoading, error: appVersionError } = useAppVersion(activeTab === 'about')
  const restartStatusQuery = useRestartRebuildStatus(activeTab === 'about')
  const [terminalPaddingDraft, setTerminalPaddingDraft] = useState(preferences.terminalPadding)
  const [uploadRateLimitDraft, setUploadRateLimitDraft] = useState(preferences.uploadRateLimitKBps)
  const [downloadRateLimitDraft, setDownloadRateLimitDraft] = useState(preferences.downloadRateLimitKBps)
  const fontSizeLabel = Number.isInteger(preferences.fontSize) ? `${preferences.fontSize}` : preferences.fontSize.toFixed(1)
  const appUpdateAvailable = !!appVersionData?.buildId && appVersionData.buildId !== APP_BUILD_ID
  const aboutStatus = appVersionError ? t('settings.aboutLoadFailed') : appVersionLoading && !appVersionData ? t('settings.aboutChecking') : appUpdateAvailable ? t('settings.aboutUpdateAvailable') : t('settings.aboutUpdateCurrent')
  const restartStatus = restartStatusQuery.data || { status: 'idle', startedAt: null, finishedAt: null, summaryLines: [], exitCode: null, errorMessage: null }
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

  const tabs = [
    { id: 'general' as const, label: t('settings.general') },
    { id: 'appearance' as const, label: t('settings.appearance') },
    { id: 'plugins' as const, label: t('settings.plugins') },
    { id: 'audit' as const, label: t('settings.auditLog') },
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
      `${t('settings.aboutLatestVersion')}: ${appVersionData?.version || '-'}`,
      `${t('settings.aboutLatestBuild')}: ${appVersionData?.buildId || '-'}`,
    ].join('\n')
    const copied = await copy(text)
    if (!copied) {
      pushToast({ type: 'error', message: t('clipboard.copyFailed') })
      return
    }
    pushToast({ type: 'success', message: t('settings.aboutCopied') })
  }
  const resetHostDraft = () => {
    setHostIdDraft('')
    setHostNameDraft('')
    setHostAddressDraft('')
    setHostUserDraft('')
    setHostPortDraft('22')
    setHostPasswordDraft('')
  }
  const openCreateHostDialog = () => {
    resetHostDraft()
    setHostDialogMode('create')
    setHostDialogOpen(true)
    setHostActionMessage('')
  }
  const openEditHostDialog = (host: any) => {
    setHostIdDraft(host.id || '')
    setHostNameDraft(host.name || '')
    setHostAddressDraft(host.address || '')
    setHostUserDraft(host.user || '')
    setHostPortDraft(String(host.port || 22))
    setHostPasswordDraft('')
    setHostDialogMode('edit')
    setHostDialogOpen(true)
    setHostActionMessage('')
  }
  const closeHostDialog = () => {
    setHostDialogOpen(false)
    setHostPasswordDraft('')
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
      if (next.status === 'error') pushToast({ type: 'error', message: next.errorMessage || t('settings.restartFailed') })
      void restartStatusQuery.refetch()
    } catch (err: any) {
      pushToast({ type: 'error', message: err?.message || t('settings.restartFailed') })
    }
  }
  const saveHost = async () => {
    setHostActionMessage('')
    try {
      await createHost.mutateAsync({
        id: hostIdDraft.trim(),
        name: hostNameDraft.trim() || undefined,
        address: hostAddressDraft.trim(),
        user: hostUserDraft.trim(),
        port: Number(hostPortDraft || '22') || 22,
        password: hostPasswordDraft ? hostPasswordDraft : undefined,
      })
      setHostActionMessage(t('settings.hostSaved'))
      closeHostDialog()
      resetHostDraft()
    } catch (err: any) {
      setHostActionMessage(err?.message || t('settings.hostSaveFailed'))
    }
  }
  const confirmDeleteHost = async () => {
    if (!pendingDeleteHostId) return
    try {
      await deleteHost.mutateAsync(pendingDeleteHostId)
      setHostActionMessage(t('settings.hostRemoved'))
    } catch (err: any) {
      setHostActionMessage(err?.message || t('settings.hostRemoveFailed'))
    }
    setPendingDeleteHostId(null)
  }
  const restartStatusLabel = restartStatus.status === 'running' ? t('settings.restartStatusRunning') : restartStatus.status === 'success' ? t('settings.restartStatusSuccess') : restartStatus.status === 'error' ? t('settings.restartStatusFailed') : t('settings.restartStatusIdle')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" onClick={onClose}>
      <div className="tmuxgo-glass tmuxgo-glass-dialog max-h-[85vh] w-full max-w-[700px] overflow-hidden rounded-apple border" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-[var(--line)] flex items-center justify-between">
          <h2 className="text-text-1 text-lg font-medium">{t('settings.title')}</h2>
          <Button variant="ghost" size="sm" aria-label="close" onClick={onClose}>✕</Button>
        </div>

        <div className="flex border-b border-[var(--line)]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm ${
                activeTab === tab.id
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-text-3 hover:text-text-1'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6 overflow-y-auto max-h-[60vh]">
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
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.connection')}</h3>
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
                      onClick={() => updatePreferences({ agentNotificationsEnabled: !preferences.agentNotificationsEnabled })}
                      className={`w-10 h-6 rounded-full relative ${preferences.agentNotificationsEnabled ? 'bg-accent' : 'bg-bg-2'}`}
                      aria-label={t('settings.agentNotificationsEnabled')}
                      aria-pressed={preferences.agentNotificationsEnabled}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${preferences.agentNotificationsEnabled ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.agentNotificationDuration')}</span>
                    <select
                      value={preferences.agentNotificationDurationMs}
                      onChange={(event) => updatePreferences({ agentNotificationDurationMs: Number(event.target.value) })}
                      disabled={!preferences.agentNotificationsEnabled}
                      className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t('settings.agentNotificationDuration')}
                    >
                      {[3000, 5000, 10000, 30000, 60000].map((duration) => <option key={duration} value={duration}>{t('settings.seconds', { count: duration / 1000 })}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.sessionContinuity')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.sessionContinuityEnabled')}</span>
                    <button
                      onClick={() => updateSessionContinuity({ enabled: !sessionContinuity.enabled })}
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.enabled ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.enabled ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.resumeOnReconnect')}</span>
                    <button
                      onClick={() => updateSessionContinuity({ resumeOnReconnect: !sessionContinuity.resumeOnReconnect })}
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.resumeOnReconnect ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.resumeOnReconnect ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.resumeOnNewDevice')}</span>
                    <button
                      onClick={() => updateSessionContinuity({ resumeOnNewDevice: !sessionContinuity.resumeOnNewDevice })}
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.resumeOnNewDevice ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.resumeOnNewDevice ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.archiveEnabled')}</span>
                    <button
                      onClick={() => updateSessionContinuity({ archive: { ...sessionContinuity.archive, enabled: !sessionContinuity.archive.enabled, captureMode: sessionContinuity.archive.enabled ? 'none' : sessionContinuity.archive.captureMode === 'none' ? 'visible' : sessionContinuity.archive.captureMode } })}
                      className={`w-10 h-6 rounded-full relative ${sessionContinuity.archive.enabled ? 'bg-accent' : 'bg-bg-2'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sessionContinuity.archive.enabled ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.archiveCaptureMode')}</span>
                    <select value={sessionContinuity.archive.captureMode === 'none' ? 'visible' : sessionContinuity.archive.captureMode} disabled={!sessionContinuity.archive.enabled} onChange={(event) => updateSessionContinuity({ archive: { ...sessionContinuity.archive, captureMode: event.target.value as 'visible' | 'history' } })} className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm disabled:opacity-50"><option value="visible">{t('settings.archiveVisible')}</option><option value="history">{t('settings.archiveHistory')}</option></select>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.archiveMaxSize')}</span>
                    <select value={sessionContinuity.archive.maxBytesPerSession} disabled={!sessionContinuity.archive.enabled} onChange={(event) => updateSessionContinuity({ archive: { ...sessionContinuity.archive, maxBytesPerSession: Number(event.target.value) } })} className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm disabled:opacity-50"><option value={262144}>256 KB</option><option value={1048576}>1 MB</option><option value={4194304}>4 MB</option><option value={16777216}>16 MB</option><option value={33554432}>32 MB</option></select>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-2 text-sm">{t('settings.archiveRetention')}</span>
                    <input type="number" min={1} max={3650} value={sessionContinuity.archive.retentionDays} disabled={!sessionContinuity.archive.enabled} onChange={(event) => updateSessionContinuity({ archive: { ...sessionContinuity.archive, retentionDays: Math.max(1, Math.min(3650, Number(event.target.value) || 1)) } })} className="tmuxgo-control tmuxgo-input w-20 rounded-apple px-2 py-1.5 text-right text-sm disabled:opacity-50" />
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
                    <Button size="sm" className="mr-2" onClick={openArchiveDialog}>{t('settings.viewArchives')}</Button>
                    <Button size="sm" onClick={() => updateSessionContinuity({ resumePoints: [] })}>
                      {t('settings.clearResumePoints')}
                    </Button>
                  </div>
                </div>
              </div>
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.hosts')}</h3>
                <div className="space-y-3 rounded-apple border border-[var(--line)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-text-3">{t('settings.hosts')}</span>
                    <Button variant="primary" size="sm" onClick={openCreateHostDialog}>{t('settings.hostNew')}</Button>
                  </div>
                  <div className="space-y-2">
                    {hosts.filter((host: any) => host.id !== 'local').map((host: any) => (
                      <div key={host.id} className="rounded-apple border border-[var(--line)] bg-bg-2 px-2 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm text-text-1">{host.name || host.id}</div>
                          <div className="truncate text-xs text-text-3">{host.id} {host.user ? `${host.user}@` : ''}{host.address}:{host.port || 22}</div>
                          {!!host.hasPassword && <div className="truncate text-xs text-text-3">{t('settings.hostPasswordSaved')}</div>}
                        </div>
                        <div className="mt-2 flex items-center gap-1">
                          <Chip onClick={() => openEditHostDialog(host)}>{t('settings.hostEdit')}</Chip>
                          <Chip
                            onClick={async () => {
                              setHostActionMessage('')
                              try {
                                const result = await testHost.mutateAsync(host.id)
                                setHostActionMessage(`${host.id}: ${result.ok ? t('settings.hostTestOk') : result.message}`)
                              } catch (err: any) {
                                setHostActionMessage(err?.message || t('settings.hostTestFailed'))
                              }
                            }}
                          >
                            {t('settings.hostTest')}
                          </Chip>
                          <Chip
                            tone="danger"
                            onClick={() => { setHostActionMessage(''); setPendingDeleteHostId(host.id) }}
                          >
                            {t('settings.hostRemove')}
                          </Chip>
                        </div>
                      </div>
                    ))}
                  </div>
                  {!!hostActionMessage && <span className="block text-xs text-text-2">{hostActionMessage}</span>}
                </div>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.terminal')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.fontSize')}</span>
                    <div className="flex items-center gap-2">
                      <Chip
                        onClick={() => updatePreferences({ fontSize: Math.max(8, Math.round((preferences.fontSize - 1) * 10) / 10) })}
                      >
                        -
                      </Chip>
                      <span className="text-text-1 text-sm w-12 text-center">{fontSizeLabel}px</span>
                      <Chip
                        onClick={() => updatePreferences({ fontSize: Math.min(20, Math.round((preferences.fontSize + 1) * 10) / 10) })}
                      >
                        +
                      </Chip>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.fontFamily')}</span>
                    <select
                      value={preferences.fontFamily}
                      onChange={(e) => updatePreferences({ fontFamily: e.target.value })}
                      className="tmuxgo-control tmuxgo-select rounded-apple px-3 py-1.5 text-sm"
                    >
                      <option value='Consolas, "Cascadia Mono", "Cascadia Code", "SF Mono", Monaco, Menlo, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace'>VS Code Mono</option>
                      <option value='JetBrains Mono, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace'>JetBrains Mono</option>
                      <option value='Fira Code, "Cascadia Code", Consolas, monospace'>Fira Code</option>
                      <option value="monospace">Monospace</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.cursorBlink')}</span>
                    <button
                      onClick={() => updatePreferences({ cursorBlink: !preferences.cursorBlink })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.cursorBlink ? 'bg-accent' : 'bg-bg-2'
                      }`}
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
                        onChange={(e) => setTerminalPaddingDraft(Number(e.target.value))}
                        onMouseUp={commitTerminalPadding}
                        onTouchEnd={commitTerminalPadding}
                        onKeyUp={commitTerminalPadding}
                        className="w-24 accent-accent"
                      />
                      <span className="text-text-1 text-sm w-8 text-center">{terminalPaddingDraft}px</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.uploadRateLimit')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={50}
                        max={2048}
                        step={50}
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
                        max={2048}
                        step={50}
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
                  {(['dark', 'light', 'high-contrast', 'dracula', 'nord', 'catppuccin'] as const).map((theme) => {
                    const key = theme === 'high-contrast' ? 'highContrast' : theme
                    return (
                      <button
                        key={theme}
                        onClick={() => updatePreferences({ theme })}
                        className={`p-3 bg-bg-2 rounded-apple border-2 ${
                          preferences.theme === theme ? 'border-accent' : 'border-transparent'
                        }`}
                      >
                        <div className="text-text-1 text-sm">
                          {t(`settings.theme.${key}` as any)}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.layout')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.sidebarPosition')}</span>
                    <div className="flex gap-2">
                      {(['left', 'right'] as const).map((pos) => (
                        <button
                          key={pos}
                          onClick={() => updatePreferences({ sidebarPosition: pos })}
                          className={`px-3 py-1.5 rounded-apple text-sm ${
                            preferences.sidebarPosition === pos
                              ? 'bg-accent text-bg-0'
                              : 'bg-bg-2 text-text-2'
                          }`}
                        >
                          {pos}
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
            </div>
          )}

          {activeTab === 'plugins' && <PluginSettings />}

          {activeTab === 'audit' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-text-1 text-sm font-medium">{t('settings.auditLog')}</h3>
                  <p className="text-text-3 text-xs mt-1">{t('settings.auditDesc')}</p>
                </div>
                <Button variant="primary" onClick={() => setShowAuditLog(true)}>
                  {t('settings.viewLog')}
                </Button>
              </div>
            </div>
          )}

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
                  <span className="text-sm text-text-1">{appVersionLoading && !appVersionData ? '...' : appVersionData?.version || '-'}</span>
                </div>
                <div className="border-t border-[var(--line)] flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-text-2">{t('settings.aboutLatestBuild')}</span>
                  <span className="text-sm text-text-1">{appVersionLoading && !appVersionData ? '...' : appVersionData?.buildId || '-'}</span>
                </div>
                <div className="border-t border-[var(--line)] flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-text-2">{t('settings.aboutUpdateStatus')}</span>
                  <span className={`text-sm ${appUpdateAvailable ? 'text-warn' : appVersionError ? 'text-danger' : 'text-accent-2'}`}>{aboutStatus}</span>
                </div>
              </div>
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-1">{t('settings.restartTitle')}</div>
                    <div className="mt-1 text-xs text-text-3">{t('settings.restartDesc')}</div>
                  </div>
                  <Button variant="primary" disabled={restartRunning} className="disabled:cursor-not-allowed" onClick={() => setRestartConfirmOpen(true)}>{t('settings.restartAction')}</Button>
                </div>
                <div className="mt-4 rounded-apple border border-[var(--line)] px-3 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-text-2">{t('settings.restartStatus')}</span>
                    <span className={`text-sm ${restartStatus.status === 'success' ? 'text-accent-2' : restartStatus.status === 'error' ? 'text-danger' : restartStatus.status === 'running' ? 'text-warn' : 'text-text-1'}`}>{restartStatusLabel}</span>
                  </div>
                  {restartStatus.summaryLines.length > 0 && (
                    <div className="mt-2 rounded-apple bg-bg-1 px-2 py-2 font-mono text-xs text-text-2">
                      {restartStatus.summaryLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
                    </div>
                  )}
                </div>
              </div>
              {appUpdateAvailable && <div className="text-xs text-text-3">{t('settings.aboutRefresh')}</div>}
              <div className="flex items-center justify-end">
                <Button variant="primary" onClick={() => void copyVersionInfo()}>{t('settings.aboutCopy')}</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {hostDialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" onClick={closeHostDialog}>
          <div className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-[420px] rounded-apple border p-4" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-medium text-text-1">{hostDialogMode === 'create' ? t('settings.hostCreate') : t('settings.hostEdit')}</h3>
              <Button variant="ghost" size="sm" aria-label="close" onClick={closeHostDialog}>✕</Button>
            </div>
            <div className="space-y-2">
              <input value={hostIdDraft} disabled={hostDialogMode === 'edit'} onChange={(event) => setHostIdDraft(event.target.value)} placeholder={t('settings.hostId')} className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60" />
              <input value={hostNameDraft} onChange={(event) => setHostNameDraft(event.target.value)} placeholder={t('settings.hostNameOptional')} className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm" />
              <input value={hostAddressDraft} onChange={(event) => setHostAddressDraft(event.target.value)} placeholder={t('settings.hostAddress')} className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm" />
              <input value={hostUserDraft} onChange={(event) => setHostUserDraft(event.target.value)} placeholder={t('settings.hostUser')} className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm" />
              <input value={hostPortDraft} onChange={(event) => setHostPortDraft(event.target.value)} placeholder={t('settings.hostPort')} className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm" />
              <input type="password" value={hostPasswordDraft} onChange={(event) => setHostPasswordDraft(event.target.value)} placeholder={t('settings.hostPassword')} className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm" />
              {hostDialogMode === 'edit' && <div className="text-xs text-text-3">{t('settings.hostPasswordKeep')}</div>}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button size="sm" onClick={closeHostDialog}>{t('common.cancel')}</Button>
              <Button variant="primary" size="sm" onClick={() => void saveHost()}>{t('settings.hostSave')}</Button>
            </div>
          </div>
        </div>
      )}
      {archiveDialogOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={() => setArchiveDialogOpen(false)}><div className="tmuxgo-glass tmuxgo-glass-dialog flex h-[75vh] w-full max-w-4xl flex-col overflow-hidden rounded-apple border" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3"><h3 className="text-base font-medium text-text-1">{t('settings.archives')}</h3><Button variant="ghost" size="sm" aria-label="close" onClick={() => setArchiveDialogOpen(false)}>✕</Button></div><div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_1fr]"><div className="tmuxgo-scrollbar overflow-y-auto border-b border-[var(--line)] md:border-b-0 md:border-r">{archiveLoading && !archives.length && <div className="p-4 text-sm text-text-3">{t('common.loading')}</div>}{!archiveLoading && !archives.length && <div className="p-4 text-sm text-text-3">{t('settings.archiveEmpty')}</div>}{archives.map((archive) => <div key={archive.id} className={`flex border-b border-[var(--line)] ${archiveDetail?.id === archive.id ? 'bg-bg-2' : ''}`}><button onClick={() => void openArchive(archive.id)} className="min-w-0 flex-1 p-3 text-left"><div className="truncate text-sm text-text-1">{archive.sessionName}</div><div className="mt-1 text-xs text-text-3">{new Date(archive.createdAt).toLocaleString()} · {archive.paneCount} · {Math.ceil(archive.size / 1024)} KB</div></button><button onClick={() => void deleteArchive(archive.id)} className="w-10 text-text-3 hover:text-danger" aria-label={t('settings.deleteArchive')}>×</button></div>)}</div><div className="tmuxgo-scrollbar min-h-0 overflow-y-auto p-4">{!archiveDetail && <div className="flex h-full items-center justify-center text-sm text-text-3">{t('settings.selectArchive')}</div>}{archiveDetail && <div className="space-y-4"><div><div className="text-base font-medium text-text-1">{archiveDetail.sessionName}</div><div className="mt-1 text-xs text-text-3">{archiveDetail.captureMode === 'history' ? t('settings.archiveHistory') : t('settings.archiveVisible')} · {new Date(archiveDetail.createdAt).toLocaleString()}</div></div>{archiveDetail.panes.map((pane) => <div key={pane.paneId}><div className="mb-1 text-xs text-text-3">{pane.windowName} / {pane.title}</div><pre className="overflow-x-auto whitespace-pre-wrap rounded-apple border border-[var(--line)] bg-bg-0 p-3 font-mono text-xs text-text-2">{pane.data || t('settings.archiveNoOutput')}</pre></div>)}</div>}</div></div></div></div>}
      <ConfirmDialog open={!!pendingDeleteHostId} title={t('settings.hostRemoveConfirmTitle')} message={t('settings.hostRemoveConfirmMessage', { name: hosts.find((host: any) => host.id === pendingDeleteHostId)?.name || pendingDeleteHostId || '' })} confirmLabel={t('settings.hostRemove')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDeleteHostId(null)} onConfirm={() => void confirmDeleteHost()} />
      <ConfirmDialog open={restartConfirmOpen} title={t('settings.restartConfirmTitle')} message={t('settings.restartConfirmMessage')} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} onCancel={() => setRestartConfirmOpen(false)} onConfirm={() => void triggerRestartRebuild()} />
      {showAuditLog && <AuditLog onClose={() => setShowAuditLog(false)} />}
    </div>
  )
}
