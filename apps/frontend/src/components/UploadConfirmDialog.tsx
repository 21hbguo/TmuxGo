'use client'
import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { quoteShellPath } from '@/lib/path-drop'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useFileRoots } from '@/hooks/useApi'
import { usePreferences } from '@/hooks/usePreferences'

function formatSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}

export function UploadConfirmDialog() {
  const uploadRequest = useConsoleStore((s) => s.uploadRequest)
  const closeUploadDialog = useConsoleStore((s) => s.closeUploadDialog)
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const { data: roots = [] } = useFileRoots()
  const { preferences } = usePreferences()
  const [targetRootId, setTargetRootId] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [insertPaths, setInsertPaths] = useState(true)
  const [loadingTarget, setLoadingTarget] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const files = uploadRequest?.files || []
  const open = files.length > 0
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files])

  useEffect(() => {
    if (!open) return
    setInsertPaths(uploadRequest?.insertPaths !== false)
    if (uploadRequest?.preferredRootId) {
      setTargetRootId(uploadRequest.preferredRootId)
      setTargetPath(uploadRequest.preferredPath || '')
      return
    }
    let cancelled = false
    setLoadingTarget(true)
    void api.files.defaultUploadTarget(activePaneId || undefined).then((target) => {
      if (cancelled) return
      setTargetRootId(target.rootId)
      setTargetPath(target.path)
    }).catch((err) => {
      if (cancelled) return
      const fallbackRoot = roots[0]
      setTargetRootId(fallbackRoot?.id || '')
      setTargetPath('')
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to resolve upload target' })
    }).finally(() => {
      if (!cancelled) setLoadingTarget(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, uploadRequest, activePaneId, roots, pushToast])

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
    try {
      const body = new FormData()
      body.append('targetRootId', targetRootId)
      body.append('targetPath', targetPath)
      body.append('conflictPolicy', 'rename')
      body.append('rateLimitKBps', String(preferences.uploadRateLimitKBps || 200))
      uploadRequest.files.forEach((file) => body.append('files', file))
      const result = await api.files.upload(body)
      if (insertPaths && result.files.length) {
        const data = result.files.map((file) => quoteShellPath(file.absolutePath)).join(' ')
        window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data } }))
      }
      pushToast({ type: 'success', message: `Uploaded ${result.files.length} file${result.files.length > 1 ? 's' : ''}` })
      closeUploadDialog()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Upload failed' })
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4" onClick={handleCancel}>
      <div className="w-full max-w-2xl rounded-lg border border-[var(--line)] bg-bg-1 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">Confirm upload</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-3">
          <div className="rounded bg-bg-2 px-2 py-1">{files.length} file{files.length > 1 ? 's' : ''}</div>
          <div className="rounded bg-bg-2 px-2 py-1">{formatSize(totalSize)}</div>
          <div className="rounded bg-bg-2 px-2 py-1">Rename on conflict</div>
          <div className="rounded bg-bg-2 px-2 py-1">{preferences.uploadRateLimitKBps}KB/s</div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[160px_1fr]">
          <label className="text-sm text-text-2">Root</label>
          <select value={targetRootId} onChange={(e) => setTargetRootId(e.target.value)} className="rounded border border-[var(--line)] bg-bg-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-accent">
            {roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <label className="text-sm text-text-2">Directory</label>
          <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} placeholder="uploads" className="rounded border border-[var(--line)] bg-bg-2 px-3 py-2 font-mono text-sm text-text-1 outline-none placeholder:text-text-3 focus:border-accent" />
          <label className="text-sm text-text-2">Target</label>
          <div className="rounded border border-[var(--line)] bg-bg-0 px-3 py-2 font-mono text-xs text-text-2">{loadingTarget ? 'Resolving default target...' : pathPreview || '-'}</div>
        </div>
        <div className="mt-4 rounded border border-[var(--line)] bg-bg-0 p-3">
          <div className="mb-2 text-xs text-text-3">Files</div>
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
          <span>Insert uploaded paths into terminal</span>
          <input type="checkbox" checked={insertPaths} onChange={(e) => setInsertPaths(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={handleCancel} className="rounded px-4 py-2 text-sm text-text-3 hover:text-text-1">Cancel</button>
          <button onClick={() => void handleUpload()} disabled={submitting || loadingTarget || !targetRootId} className="rounded bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? 'Uploading...' : 'Upload'}</button>
        </div>
      </div>
    </div>
  )
}
