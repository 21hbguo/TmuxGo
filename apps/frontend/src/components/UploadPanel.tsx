'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiUpload, FiX } from 'react-icons/fi'
import { api } from '@/lib/api'
import {
  CATEGORY_ICON,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  fileCategory,
  fileTypeLabel,
  formatFileSize,
  stageRejectionMessage,
  stageUploadFiles,
  summarizeCategories,
} from '@/lib/file-meta'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useFileRoots, useHosts } from '@/hooks/useApi'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { Select } from './Select'
import { UploadJobCard } from './UploadJobCard'

// 独立上传入口页：选择文件（全局常驻 input）→ 目标预选可见可改 → 复用
// UploadConfirmDialog 做安全确认与队列。任务存全局 store，离开本页不取消、重进可见。
export function UploadPanel({ mode = 'desktop', onClose }: { mode?: 'mobile' | 'desktop'; onClose?: () => void }) {
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const uploadJobs = useConsoleStore((s) => s.uploadJobs)
  const stagedFiles = useConsoleStore((s) => s.stagedUploadFiles)
  const setStagedUploadFiles = useConsoleStore((s) => s.setStagedUploadFiles)
  const openUploadDialog = useConsoleStore((s) => s.openUploadDialog)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const clearFinishedUploadJobs = useConsoleStore((s) => s.clearFinishedUploadJobs)
  const { data: hosts = [] } = useHosts()
  const [hostId, setHostId] = useState('')
  const effectiveHostId = hostId || activeHostId || 'local'
  const { data: roots = [] } = useFileRoots(effectiveHostId)
  const [targetRootId, setTargetRootId] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [loadingTarget, setLoadingTarget] = useState(false)
  const [initializedHost, setInitializedHost] = useState('')
  useEscapeClose(() => onClose?.(), mode === 'desktop')

  // 目标预填：跟随当前主机 + 活动 pane 目录解析；失败回落到首个 root 顶层。
  // 仅每 host 首次执行一次，后续手改目录不被回源覆盖；切主机后重新解析
  useEffect(() => {
    if (initializedHost === effectiveHostId) return
    setInitializedHost(effectiveHostId)
    setLoadingTarget(true)
    void api.files
      .defaultUploadTarget(effectiveHostId, activePaneId || undefined)
      .then((target) => {
        setTargetRootId(target.rootId)
        setTargetPath(target.path)
      })
      .catch(() => {
        setTargetRootId('')
        setTargetPath('')
      })
      .finally(() => setLoadingTarget(false))
  }, [effectiveHostId, activePaneId, initializedHost])
  useEffect(() => {
    if (!targetRootId && roots.length) setTargetRootId(roots[0].id)
  }, [roots, targetRootId])

  const hostOptions = useMemo(() => {
    const online = hosts.filter((host: any) => host.status === 'online' || host.id === 'local')
    const list = online.length ? online : hosts
    return list.length
      ? list.map((host: any) => ({ value: host.id, label: host.name || host.id }))
      : [{ value: 'local', label: 'local' }]
  }, [hosts])
  const rootOptions = roots.map((item) => ({ value: item.id, label: `${item.label} · ${item.path}` }))

  // 选文件走全局常驻 input（stage 模式）：文件先落全局暂存列表显示在页面，
  // 用户核对目标后再点「上传」进入既有安全确认弹窗——不猜测路径自动上传
  const pickFiles = () => {
    window.dispatchEvent(new CustomEvent('tmuxgo-pick-upload-files', { detail: { stage: true } }))
  }
  const [dragActive, setDragActive] = useState(false)
  // 三条入口共用同一暂存校验；读 getState 保证拖拽/粘贴回调拿到最新暂存
  const stageIncoming = useCallback(
    (incoming: File[]) => {
      if (!incoming.length) return
      const before = useConsoleStore.getState().stagedUploadFiles
      const staged = stageUploadFiles(before, incoming)
      if (staged.files.length !== before.length) setStagedUploadFiles(staged.files)
      if (staged.rejected.length) pushToast({ type: 'error', message: stageRejectionMessage(staged.rejected, t) })
    },
    [setStagedUploadFiles, pushToast, t],
  )
  // 拖放仅认真实文件（types 含 Files）——面板内部条目拖拽没有 files，不误触发；
  // 移动端浏览器基本不产生文件拖拽/粘贴事件，挂着也无副作用
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false)
  }, [])
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      setDragActive(false)
      // 目录项剔除：dataTransfer.files 会把拖入的目录伪装成 0 字节同名 File，
      // 传上去就是个空文件——经 items.webkitGetAsEntry 识别，两者按索引一一对应
      const items = Array.from(e.dataTransfer.items || [])
      const files = Array.from(e.dataTransfer.files)
      const accepted = files.filter((_, i) => items[i]?.webkitGetAsEntry?.()?.isDirectory !== true)
      const dirCount = files.length - accepted.length
      if (dirCount) pushToast({ type: 'info', message: t('uploadTab.skipDir', { count: dirCount }) })
      stageIncoming(accepted)
    },
    [stageIncoming, pushToast, t],
  )
  // 剪贴板带文件才接管（preventDefault）；纯文本粘贴照常落到输入框
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || [])
      if (!files.length) return
      e.preventDefault()
      stageIncoming(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [stageIncoming])
  const removeStaged = (index: number) => setStagedUploadFiles(stagedFiles.filter((_: File, i: number) => i !== index))
  const stagedSize = stagedFiles.reduce((sum: number, file: File) => sum + file.size, 0)
  const stagedCategories = useMemo(() => summarizeCategories(stagedFiles), [stagedFiles])
  const submitStaged = () => {
    if (!stagedFiles.length || !targetRootId) return
    openUploadDialog({
      files: stagedFiles,
      hostId: effectiveHostId,
      preferredRootId: targetRootId,
      preferredPath: targetPath,
    })
    // 交接确认弹窗后清空暂存：取消弹窗=回到本页重新挑选，避免与已提交任务双列混淆
    setStagedUploadFiles([])
  }

  const content = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-2.5">
        <FiUpload aria-hidden="true" className="shrink-0 text-accent" size={16} />
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-1">{t('uploadTab.title')}</div>
        {onClose && (
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--lg shrink-0 text-text-3"
          >
            <FiX aria-hidden="true" size={16} />
          </button>
        )}
      </div>
      <div
        className={`tmuxgo-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3 ${dragActive ? 'ring-1 ring-inset ring-accent' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Button variant="primary" size="sm" className="w-full justify-center" onClick={pickFiles}>
          <FiUpload aria-hidden="true" size={14} className="mr-1.5 inline" />
          {t('uploadTab.chooseFiles')}
        </Button>
        <div className="text-caption leading-relaxed text-text-3">
          {t('uploadTab.anyType', {
            maxFile: formatFileSize(MAX_UPLOAD_FILE_BYTES),
            maxCount: MAX_UPLOAD_FILES,
          })}
          {' · '}
          {t('uploadTab.dropHint')}
        </div>
        {stagedFiles.length > 0 && (
          <div className="rounded-apple border border-[var(--line)] bg-bg-0">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-1.5">
              <span className="min-w-0 truncate text-caption text-text-3">
                {t('uploadTab.staged', { count: stagedFiles.length })}
                {stagedCategories.length > 1 && (
                  <span className="text-text-3/80">
                    {' · '}
                    {stagedCategories.map(([category, count]) => `${t(`uploadCat.${category}`)}×${count}`).join(' · ')}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="shrink-0 text-caption text-text-3 hover:text-text-1"
                onClick={() => setStagedUploadFiles([])}
              >
                {t('uploadTab.clear')}
              </button>
            </div>
            <div className="tmuxgo-scrollbar max-h-40 divide-y divide-[var(--line)] overflow-y-auto">
              {stagedFiles.map((file: File, index: number) => {
                const Icon = CATEGORY_ICON[fileCategory(file)]
                return (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    className="flex items-center gap-2 px-3 py-1.5"
                  >
                    <Icon aria-hidden="true" size={14} className="shrink-0 text-text-3" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-text-1">{file.name}</div>
                      <div className="truncate text-meta text-text-3">{fileTypeLabel(file, t('uploadTab.noExt'))}</div>
                    </div>
                    <span className="shrink-0 text-meta text-text-3">{formatFileSize(file.size)}</span>
                    <button
                      type="button"
                      aria-label={t('uploadTab.remove')}
                      className="shrink-0 text-text-3 hover:text-danger"
                      onClick={() => removeStaged(index)}
                    >
                      <FiX aria-hidden="true" size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        <div className="space-y-2">
          <label className="block text-caption text-text-3">{t('uploadTab.host')}</label>
          <Select
            value={effectiveHostId}
            onChange={setHostId}
            options={hostOptions}
            className="w-full rounded-apple px-3 py-2 text-sm"
            aria-label={t('uploadTab.host')}
          />
          <label className="block text-caption text-text-3">{t('upload.root')}</label>
          <Select
            value={targetRootId}
            onChange={setTargetRootId}
            options={rootOptions}
            className="w-full rounded-apple px-3 py-2 text-sm"
            aria-label={t('upload.root')}
          />
          <label className="block text-caption text-text-3">{t('upload.directory')}</label>
          <input
            value={targetPath}
            onChange={(e) => setTargetPath(e.target.value)}
            placeholder={t('upload.directory')}
            className="tmuxgo-control tmuxgo-input w-full rounded-apple px-3 py-2 font-mono text-sm"
          />
        </div>
        {stagedFiles.length > 0 && (
          <Button
            variant="primary"
            size="sm"
            className="w-full justify-center"
            disabled={!targetRootId || loadingTarget}
            onClick={submitStaged}
          >
            {t('uploadTab.submit', { count: stagedFiles.length, size: formatFileSize(stagedSize) })}
          </Button>
        )}
        <div className="text-caption leading-relaxed text-text-3">
          {loadingTarget ? t('upload.resolving') : t('uploadTab.submitHint')}
        </div>

        <div>
          <div className="flex items-center justify-between pb-2">
            <span className="text-caption font-medium text-text-2">{t('uploadTab.jobs')}</span>
            {uploadJobs.length > 0 && (
              <button
                type="button"
                className="text-caption text-text-3 hover:text-text-1"
                onClick={clearFinishedUploadJobs}
              >
                {t('uploadQueue.clean')}
              </button>
            )}
          </div>
          {uploadJobs.length === 0 ? (
            <div className="rounded-apple border border-dashed border-[var(--line)] px-3 py-4 text-center text-caption text-text-3">
              {t('uploadTab.noJobs')}
            </div>
          ) : (
            <div className="space-y-2">
              {uploadJobs.map((job) => (
                <UploadJobCard key={job.id} job={job} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  if (mode === 'mobile') return content
  return (
    <ModalPortal>
      <div className="tmuxgo-scrim fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog h-[min(640px,85vh)] w-full max-w-lg rounded-apple border"
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      </div>
    </ModalPortal>
  )
}
