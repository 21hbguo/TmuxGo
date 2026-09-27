'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import {
  CATEGORY_ICON,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  fileCategory,
  fileTypeLabel,
  formatFileSize,
  summarizeCategories,
} from '@/lib/file-meta'
import { quoteShellPath } from '@/lib/path-drop'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useFileRoots, useSessionSnapshot } from '@/hooks/useApi'
import { usePreferences } from '@/hooks/usePreferences'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { useTranslation } from '@/i18n'
import type { FileUploadTarget } from '@/types'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { Select } from './Select'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker'
import { FiFolder } from 'react-icons/fi'

export function UploadConfirmDialog() {
  const uploadRequest = useConsoleStore((s) => s.uploadRequest)
  const closeUploadDialog = useConsoleStore((s) => s.closeUploadDialog)
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const addUploadJob = useConsoleStore((s) => s.addUploadJob)
  const updateUploadJob = useConsoleStore((s) => s.updateUploadJob)
  const removeUploadJob = useConsoleStore((s) => s.removeUploadJob)
  // 转发等场景可显式指定目标 host；缺省跟随当前活动主机
  const hostId = uploadRequest?.hostId || activeHostId || 'local'
  const { data: roots = [] } = useFileRoots(hostId)
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const [targetRootId, setTargetRootId] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  const [insertPaths, setInsertPaths] = useState(false)
  const [insertPaneId, setInsertPaneId] = useState('')
  const [insertFormat, setInsertFormat] = useState<'inline' | 'lines'>('inline')
  // 终端输入通道只到达当前附着会话的活动 pane——插入目标限定该会话内 pane，
  // 否则会出现"选了 A 窗格却写进 B"的静默错投
  const { data: insertSnapshot } = useSessionSnapshot(activeHostId || '', activeSessionId || '')
  const insertPaneOptions = (insertSnapshot?.panes || []).map((pane: any) => ({
    value: pane.id as string,
    label: `${pane.windowName ? `${pane.windowName} · ` : ''}${pane.title || pane.id} · ${pane.tmuxPaneId || pane.id.split(':').pop()}`,
  }))
  // snapshot 未返回前也要让「当前 pane」可选，否则勾选框会闪灰
  if (activePaneId && !insertPaneOptions.some((option) => option.value === activePaneId))
    insertPaneOptions.unshift({ value: activePaneId, label: `${activePaneId.split(':').pop()}` })
  const [loadingTarget, setLoadingTarget] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [temporaryTarget, setTemporaryTarget] = useState<FileUploadTarget | null>(null)
  const initializedRequestRef = useRef('')
  const rootsRef = useRef(roots)
  // useMemo 包裹避免 `|| []` 每次渲染新引用导致下游 memo 失效（exhaustive-deps 告警）
  const files = useMemo(() => uploadRequest?.files || [], [uploadRequest])
  const open = files.length > 0
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files])
  const categorySummary = useMemo(() => summarizeCategories(files), [files])
  // 上传类型不限；唯一硬约束是大小/数量（与服务端 multipart limits 对齐）。
  // 这里只做提交前的友好提示，服务端仍是权威拒绝
  const oversized = files.filter((file) => file.size > MAX_UPLOAD_FILE_BYTES)
  const limitError =
    files.length > MAX_UPLOAD_FILES
      ? t('upload.tooMany', { max: MAX_UPLOAD_FILES })
      : oversized.length
        ? t('upload.fileTooLarge', { name: oversized[0].name, max: formatFileSize(MAX_UPLOAD_FILE_BYTES) })
        : ''
  const requestKey = useMemo(
    () =>
      open
        ? `${uploadRequest?.temporary ? 'tmp' : 'default'}:${uploadRequest?.preferredRootId || ''}:${uploadRequest?.preferredPath || ''}:${files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')}`
        : '',
    [open, uploadRequest?.temporary, uploadRequest?.preferredRootId, uploadRequest?.preferredPath, files],
  )

  useEffect(() => {
    rootsRef.current = roots
  }, [roots])
  useEffect(() => {
    if (!open) {
      initializedRequestRef.current = ''
      return
    }
    if (initializedRequestRef.current === requestKey) return
    initializedRequestRef.current = requestKey
    // 默认不插入终端：仅调用方显式声明（如终端粘贴流）才预勾选
    setInsertPaths(uploadRequest?.insertPaths === true)
    setInsertPaneId(activePaneId || '')
    setInsertFormat('inline')
    setTemporaryTarget(null)
    if (uploadRequest?.temporary) {
      let cancelled = false
      setTargetRootId('')
      setTargetPath('')
      setLoadingTarget(true)
      void api.files
        .temporaryUploadTarget(hostId)
        .then((target) => {
          if (cancelled) return
          setTemporaryTarget(target)
          setTargetRootId(target.rootId)
          setTargetPath(target.path)
        })
        .catch((err) => {
          if (!cancelled)
            pushToast({ type: 'error', message: err instanceof Error ? err.message : t('upload.resolveFailed') })
        })
        .finally(() => {
          if (!cancelled) setLoadingTarget(false)
        })
      return () => {
        cancelled = true
      }
    }
    if (uploadRequest?.preferredRootId) {
      setTargetRootId(uploadRequest.preferredRootId)
      setTargetPath(uploadRequest.preferredPath || '')
      setLoadingTarget(false)
      return
    }
    let cancelled = false
    setLoadingTarget(true)
    void api.files
      .defaultUploadTarget(hostId, activePaneId || undefined)
      .then((target) => {
        if (cancelled) return
        setTargetRootId(target.rootId)
        setTargetPath(target.path)
      })
      .catch((err) => {
        if (cancelled) return
        const fallbackRoot = rootsRef.current[0]
        setTargetRootId(fallbackRoot?.id || '')
        setTargetPath('')
        pushToast({ type: 'error', message: err instanceof Error ? err.message : t('upload.resolveFailed') })
      })
      .finally(() => {
        if (!cancelled) setLoadingTarget(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, requestKey, uploadRequest, activePaneId, hostId, pushToast, t])
  useEffect(() => {
    if (!open || uploadRequest?.temporary || targetRootId || !roots.length) return
    setTargetRootId(roots[0].id)
  }, [open, uploadRequest?.temporary, targetRootId, roots])

  const activeRoot =
    temporaryTarget && temporaryTarget.rootId === targetRootId
      ? { id: temporaryTarget.rootId, label: temporaryTarget.rootLabel, path: temporaryTarget.rootPath }
      : roots.find((item) => item.id === targetRootId) || roots[0] || null
  const pathPreview = useMemo(() => {
    if (!activeRoot) return ''
    const normalized = targetPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
    return normalized ? `${activeRoot.path}/${normalized}` : activeRoot.path
  }, [activeRoot, targetPath])

  const handleCancel = () => {
    if (submitting) return
    closeUploadDialog()
  }
  useEscapeClose(handleCancel, open)

  // 上传成功后投递路径：非当前 pane 先经 tmux select（必要时先切 window），
  // 再走统一粘贴确认（analyzePaste 检查 + 用户确认发送），绝不自动追加 Enter/直写终端。
  // 只投递服务端返回的 absolutePath（已 shell-quote），不含本地路径/文件内容
  const deliverUploadedPaths = async (quotedPaths: string[], opts: { paneId: string; format: 'inline' | 'lines' }) => {
    if (!quotedPaths.length) return
    const paneLabel = insertPaneOptions.find((o) => o.value === opts.paneId)?.label || opts.paneId
    if (!opts.paneId) {
      pushToast({ type: 'error', message: t('upload.insertNoPane') })
      return
    }
    try {
      if (opts.paneId !== activePaneId) {
        const pane = (insertSnapshot?.panes || []).find((item: any) => item.id === opts.paneId)
        if (!pane) throw new Error(t('upload.insertNoPane'))
        if (pane.windowId && pane.windowId !== insertSnapshot?.activeWindowId && activeHostId && activeSessionId)
          await api.windows.select(activeHostId, activeSessionId, pane.windowId)
        const selected = await api.panes.select(opts.paneId)
        if (!selected?.ok) throw new Error(selected?.error || t('upload.insertSelectFailed'))
        useConsoleStore.getState().setActivePane(opts.paneId)
      }
      const text = opts.format === 'lines' ? quotedPaths.join('\n') : quotedPaths.join(' ')
      window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text, source: 'memory' } }))
      pushToast({ type: 'info', message: t('upload.insertPendingConfirm', { pane: paneLabel }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('upload.insertFailed') })
    }
  }

  const handleUpload = async () => {
    if (!uploadRequest || !targetRootId || limitError) return
    setSubmitting(true)
    // 提交瞬间冻结插入选项：弹窗关闭后异步完成回调仍用此刻的目标 pane/格式
    const insertOpts = { paneId: insertPaneId, format: insertFormat }
    // 整体失败语义：任一文件失败即整批任务 error，服务端不落盘半成品批，
    // 这里明确告知用户没有任何路径被插入（不回滚已上传文件）
    const notifyInsertSkipped = () => {
      if (insertPaths) pushToast({ type: 'info', message: t('upload.insertSkipped') })
    }
    const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const totalBytes = uploadRequest.files.reduce((sum, file) => sum + file.size, 0)
    try {
      const body = new FormData()
      body.append('targetRootId', targetRootId)
      body.append('targetPath', targetPath)
      body.append('conflictPolicy', 'rename')
      body.append('rateLimitKBps', String(preferences.uploadRateLimitKBps || 5120))
      body.append('background', 'true')
      uploadRequest.files.forEach((file) => body.append('files', file))
      addUploadJob({
        id: jobId,
        hostId,
        files: uploadRequest.files.map((file) => ({ name: file.name, size: file.size })),
        // 失败重试需要原 File 引用重开确认弹窗；成功后在下方分支释放
        sourceFiles: uploadRequest.files,
        targetRootId,
        targetPath,
        insertPaths,
        loadedBytes: 0,
        totalBytes,
        status: 'queued',
        createdAt: new Date().toISOString(),
      })
      // 重试来源的旧失败 job 此时才移除——确认提交后取代，取消/校验失败则保留记录
      if (uploadRequest.replacesJobId) removeUploadJob(uploadRequest.replacesJobId)
      closeUploadDialog()
      const result = await api.files.upload(hostId, body, (loadedBytes, uploadTotalBytes) => {
        updateUploadJob(jobId, { loadedBytes, totalBytes: uploadTotalBytes || totalBytes, status: 'uploading' })
      })
      if ('task' in result) {
        updateUploadJob(jobId, { loadedBytes: totalBytes, totalBytes, status: 'queued' })
        pushToast({ type: 'success', message: t('tasks.queued') })
        void (async () => {
          for (let attempt = 0; attempt < 7200; attempt += 1) {
            try {
              const task = (await api.system.tasks()).tasks.find((item) => item.id === result.task.id)
              if (task?.status === 'success') {
                const taskResult =
                  task.result && typeof task.result === 'object'
                    ? (task.result as { files?: { absolutePath?: unknown }[] })
                    : null
                const uploadedFiles =
                  taskResult?.files?.filter(
                    (file): file is { absolutePath: string } => typeof file.absolutePath === 'string',
                  ) || []
                updateUploadJob(jobId, {
                  loadedBytes: totalBytes,
                  totalBytes,
                  status: 'success',
                  finishedAt: new Date().toISOString(),
                  sourceFiles: undefined,
                })
                if (insertPaths && uploadedFiles.length)
                  void deliverUploadedPaths(
                    uploadedFiles.map((file) => quoteShellPath(file.absolutePath)),
                    insertOpts,
                  )
                return
              }
              if (task && task.status !== 'running') {
                updateUploadJob(jobId, {
                  status: 'error',
                  finishedAt: new Date().toISOString(),
                  errorMessage: task.errorMessage || t('upload.failed'),
                })
                notifyInsertSkipped()
                return
              }
            } catch {}
            await new Promise((resolve) => window.setTimeout(resolve, 500))
          }
          updateUploadJob(jobId, {
            status: 'error',
            finishedAt: new Date().toISOString(),
            errorMessage: t('upload.failed'),
          })
          notifyInsertSkipped()
        })()
        return
      }
      updateUploadJob(jobId, {
        loadedBytes: totalBytes,
        totalBytes,
        status: 'success',
        finishedAt: new Date().toISOString(),
        result,
        sourceFiles: undefined,
      })
      if (insertPaths && result.files.length)
        void deliverUploadedPaths(
          result.files.map((file) => quoteShellPath(file.absolutePath)),
          insertOpts,
        )
      pushToast({ type: 'success', message: t('upload.uploaded', { count: result.files.length }) })
    } catch (err) {
      updateUploadJob(jobId, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        errorMessage: err instanceof Error ? err.message : t('upload.failed'),
      })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('upload.failed') })
      notifyInsertSkipped()
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <ModalPortal>
      {/* 移动端：弹窗高度受 --app-height 约束并自滚，确认/取消按钮不会被键盘或安全区挤出视口 */}
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center tmuxgo-scrim p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        onClick={handleCancel}
      >
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog tmuxgo-scrollbar max-h-[calc(var(--app-height,100dvh)-2rem-env(safe-area-inset-bottom))] w-full max-w-2xl overflow-y-auto rounded-apple border p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-lg text-text-1">{t('upload.title')}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-3">
            <div className="tmuxgo-chip">{t('upload.file', { count: files.length })}</div>
            <div className="tmuxgo-chip">{formatFileSize(totalSize)}</div>
            {categorySummary.length > 1 && (
              <div className="tmuxgo-chip">
                {categorySummary.map(([category, count]) => `${t(`uploadCat.${category}`)}×${count}`).join(' · ')}
              </div>
            )}
            <div className="tmuxgo-chip">{t('upload.renameConflict')}</div>
            <div className="tmuxgo-chip">{preferences.uploadRateLimitKBps}KB/s</div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[160px_1fr]">
            <label className="text-sm text-text-2">{t('upload.root')}</label>
            <Select
              value={targetRootId}
              onChange={setTargetRootId}
              disabled={!!uploadRequest?.temporary}
              options={
                temporaryTarget && uploadRequest?.temporary
                  ? [{ value: temporaryTarget.rootId, label: temporaryTarget.rootLabel }]
                  : roots.map((item) => ({ value: item.id, label: item.label }))
              }
              className="rounded-apple px-3 py-2 text-sm disabled:opacity-70"
            />
            <label className="text-sm text-text-2">{t('upload.directory')}</label>
            <div className="flex gap-1.5">
              <input
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
                disabled={!!uploadRequest?.temporary}
                placeholder={t('upload.directory')}
                className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-3 py-2 font-mono text-sm disabled:opacity-70"
              />
              {/* 与工作区目录选择同一弹窗；弹窗层级需高于本对话框（z-120） */}
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('uploadTab.browse')}
                title={t('uploadTab.browse')}
                disabled={!!uploadRequest?.temporary}
                onClick={() => setDirPickerOpen(true)}
              >
                <FiFolder aria-hidden="true" size={15} />
                {t('uploadTab.browse')}
              </Button>
            </div>
            <label className="text-sm text-text-2">{t('upload.target')}</label>
            <div className="rounded-apple border border-[var(--line)] bg-bg-0 px-3 py-2 font-mono text-xs text-text-2">
              {loadingTarget ? t('upload.resolving') : pathPreview || '-'}
            </div>
          </div>
          <div className="mt-4 rounded-apple border border-[var(--line)] bg-bg-0 p-3">
            <div className="mb-2 text-xs text-text-3">{t('upload.filesLabel')}</div>
            <div className="tmuxgo-scrollbar max-h-48 space-y-1 overflow-auto">
              {files.map((file) => {
                const Icon = CATEGORY_ICON[fileCategory(file)]
                return (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    className="flex items-center gap-3 rounded-apple bg-bg-2 px-3 py-2 text-xs"
                  >
                    <Icon aria-hidden="true" size={14} className="shrink-0 text-text-3" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-text-1">{file.name}</div>
                      {/* 显示实际 MIME/扩展名（未知→octet-stream），类型不限 */}
                      <div className="truncate text-meta text-text-3">{fileTypeLabel(file, t('uploadTab.noExt'))}</div>
                    </div>
                    <div className="shrink-0 text-text-3">{formatFileSize(file.size)}</div>
                  </div>
                )
              })}
            </div>
          </div>
          {limitError && (
            <div className="mt-3 rounded-apple border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {limitError}
            </div>
          )}
          <div className="mt-4 rounded-apple border border-[var(--line)] bg-bg-0 px-3 py-2">
            <label className="flex items-center justify-between text-sm text-text-2">
              <span>{t('upload.insertPaths')}</span>
              <input
                type="checkbox"
                checked={insertPaths}
                disabled={!insertPaneOptions.length}
                onChange={(e) => setInsertPaths(e.target.checked)}
                className="h-4 w-4 accent-[rgb(var(--accent))]"
              />
            </label>
            {insertPaths && (
              <div className="mt-2 space-y-2">
                <Select
                  value={insertPaneId}
                  onChange={setInsertPaneId}
                  options={insertPaneOptions}
                  aria-label={t('upload.insertPane')}
                  className="w-full rounded-apple px-3 py-2 text-sm"
                />
                {files.length > 1 && (
                  <Select
                    value={insertFormat}
                    onChange={(v) => setInsertFormat(v as 'inline' | 'lines')}
                    options={[
                      { value: 'inline', label: t('upload.insertInline') },
                      { value: 'lines', label: t('upload.insertLines') },
                    ]}
                    aria-label={t('upload.insertFormat')}
                    className="w-full rounded-apple px-3 py-2 text-sm"
                  />
                )}
                <div className="text-caption leading-relaxed text-text-3">{t('upload.insertHint')}</div>
              </div>
            )}
            {!insertPaneOptions.length && (
              <div className="mt-1.5 text-caption text-text-3">{t('upload.insertNoPane')}</div>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              {t('upload.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={submitting || loadingTarget || !targetRootId || !!limitError}
              onClick={() => void handleUpload()}
            >
              {submitting ? t('upload.starting') : t('upload.upload')}
            </Button>
          </div>
        </div>
      </div>
      {dirPickerOpen && (
        <WorkspaceDirectoryPicker
          hostId={hostId}
          title={t('uploadTab.pickDirectory')}
          initialRootId={targetRootId}
          initialPath={targetPath}
          zIndex={130}
          onPick={(target) => {
            setTargetRootId(target.rootId)
            setTargetPath(target.relativePath)
            setDirPickerOpen(false)
          }}
          onClose={() => setDirPickerOpen(false)}
        />
      )}
    </ModalPortal>
  )
}
