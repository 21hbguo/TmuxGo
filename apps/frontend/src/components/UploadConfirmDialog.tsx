'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { quoteShellPath } from '@/lib/path-drop'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useFileRoots } from '@/hooks/useApi'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'

function formatSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}

export function UploadConfirmDialog() {
  const uploadRequest = useConsoleStore((s) => s.uploadRequest)
  const closeUploadDialog = useConsoleStore((s) => s.closeUploadDialog)
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const addUploadJob = useConsoleStore((s) => s.addUploadJob)
  const updateUploadJob = useConsoleStore((s) => s.updateUploadJob)
  const hostId = activeHostId || 'local'
  const { data: roots = [] } = useFileRoots(hostId)
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const [targetRootId, setTargetRootId] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [insertPaths, setInsertPaths] = useState(true)
  const [loadingTarget, setLoadingTarget] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const initializedRequestRef = useRef('')
  const files = uploadRequest?.files || []
  const open = files.length > 0
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files])
  const requestKey = useMemo(() => open ? `${uploadRequest?.preferredRootId || ''}:${uploadRequest?.preferredPath || ''}:${files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')}` : '', [open, uploadRequest?.preferredRootId, uploadRequest?.preferredPath, files])

  useEffect(() => {
    if (!open) {
      initializedRequestRef.current = ''
      return
    }
    if (initializedRequestRef.current === requestKey) return
    initializedRequestRef.current = requestKey
    setInsertPaths(uploadRequest?.insertPaths !== false)
    if (uploadRequest?.preferredRootId) {
      setTargetRootId(uploadRequest.preferredRootId)
      setTargetPath(uploadRequest.preferredPath || '')
      setLoadingTarget(false)
      return
    }
    let cancelled = false
    setLoadingTarget(true)
    void api.files.defaultUploadTarget(hostId, activePaneId || undefined).then((target) => {
      if (cancelled) return
      setTargetRootId(target.rootId)
      setTargetPath(target.path)
    }).catch((err) => {
      if (cancelled) return
      const fallbackRoot = roots[0]
      setTargetRootId(fallbackRoot?.id || '')
      setTargetPath('')
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('upload.resolveFailed') })
    }).finally(() => {
      if (!cancelled) setLoadingTarget(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, requestKey, uploadRequest, activePaneId, hostId, roots, pushToast])
  useEffect(() => {
    if (!open || targetRootId || !roots.length) return
    setTargetRootId(roots[0].id)
  }, [open, targetRootId, roots])

  const activeRoot = roots.find((item) => item.id === targetRootId) || roots[0] || null
  const pathPreview = useMemo(() => {
    if (!activeRoot) return ''
    const normalized = targetPath.split(/[\\/]+/).filter(Boolean).join('/')
    return normalized ? `${activeRoot.path}/${normalized}` : activeRoot.path
  }, [activeRoot, targetPath])

  const handleCancel = () => {
    if (submitting) return
    closeUploadDialog()
  }

  const handleUpload = async () => {
    if (!uploadRequest || !targetRootId) return
    setSubmitting(true)
    const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const totalBytes = uploadRequest.files.reduce((sum, file) => sum + file.size, 0)
    try {
      const body = new FormData()
      body.append('targetRootId', targetRootId)
      body.append('targetPath', targetPath)
      body.append('conflictPolicy', 'rename')
      body.append('rateLimitKBps', String(preferences.uploadRateLimitKBps || 200))
      uploadRequest.files.forEach((file) => body.append('files', file))
      addUploadJob({
        id: jobId,
        files: uploadRequest.files.map((file) => ({ name: file.name, size: file.size })),
        targetRootId,
        targetPath,
        insertPaths,
        loadedBytes: 0,
        totalBytes,
        status: 'queued',
        createdAt: new Date().toISOString(),
      })
      closeUploadDialog()
      const result = await api.files.upload(hostId, body, (loadedBytes, uploadTotalBytes) => {
        updateUploadJob(jobId, { loadedBytes, totalBytes: uploadTotalBytes || totalBytes, status: 'uploading' })
      })
      updateUploadJob(jobId, { loadedBytes: totalBytes, totalBytes, status: 'success', finishedAt: new Date().toISOString(), result })
      if (insertPaths && result.files.length) {
        const data = result.files.map((file) => quoteShellPath(file.absolutePath)).join(' ')
        window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data } }))
      }
      pushToast({ type: 'success', message: t('upload.uploaded', { count: result.files.length }) })
    } catch (err) {
      updateUploadJob(jobId, { status: 'error', finishedAt: new Date().toISOString(), errorMessage: err instanceof Error ? err.message : t('upload.failed') })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('upload.failed') })
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4" onClick={handleCancel}>
      <div className="w-full max-w-2xl rounded-lg border border-[var(--line)] bg-bg-1 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">{t('upload.title')}</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-3">
          <div className="rounded bg-bg-2 px-2 py-1">{t('upload.file', { count: files.length })}</div>
          <div className="rounded bg-bg-2 px-2 py-1">{formatSize(totalSize)}</div>
          <div className="rounded bg-bg-2 px-2 py-1">{t('upload.renameConflict')}</div>
          <div className="rounded bg-bg-2 px-2 py-1">{preferences.uploadRateLimitKBps}KB/s</div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[160px_1fr]">
          <label className="text-sm text-text-2">{t('upload.root')}</label>
          <select value={targetRootId} onChange={(e) => setTargetRootId(e.target.value)} className="tmuxgo-control tmuxgo-select rounded px-3 py-2 text-sm">
            {roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <label className="text-sm text-text-2">{t('upload.directory')}</label>
          <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} placeholder={t('upload.directory')} className="tmuxgo-control tmuxgo-input rounded px-3 py-2 font-mono text-sm" />
          <label className="text-sm text-text-2">{t('upload.target')}</label>
          <div className="rounded border border-[var(--line)] bg-bg-0 px-3 py-2 font-mono text-xs text-text-2">{loadingTarget ? t('upload.resolving') : pathPreview || '-'}</div>
        </div>
        <div className="mt-4 rounded border border-[var(--line)] bg-bg-0 p-3">
          <div className="mb-2 text-xs text-text-3">{t('upload.filesLabel')}</div>
          <div className="max-h-48 space-y-1 overflow-auto">
            {files.map((file) => (
              <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center gap-3 rounded bg-bg-2 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1 truncate font-mono text-text-1">{file.name}</div>
                <div className="shrink-0 text-text-3">{formatSize(file.size)}</div>
              </div>
            ))}
          </div>
        </div>
        <label className="mt-4 flex items-center justify-between rounded border border-[var(--line)] bg-bg-0 px-3 py-2 text-sm text-text-2">
          <span>{t('upload.insertPaths')}</span>
          <input type="checkbox" checked={insertPaths} onChange={(e) => setInsertPaths(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={handleCancel} className="rounded px-4 py-2 text-sm text-text-3 hover:text-text-1">{t('upload.cancel')}</button>
          <button onClick={() => void handleUpload()} disabled={submitting || loadingTarget || !targetRootId} className="rounded bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? t('upload.starting') : t('upload.upload')}</button>
        </div>
      </div>
    </div>
  )
}
