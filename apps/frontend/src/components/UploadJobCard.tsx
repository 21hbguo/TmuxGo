'use client'

import { CATEGORY_ICON, fileCategory, formatFileSize } from '@/lib/file-meta'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import type { UploadJob } from '@/types'

function formatPercent(loadedBytes: number, totalBytes: number) {
  if (!totalBytes) return 0
  return Math.max(0, Math.min(100, Math.round((loadedBytes / totalBytes) * 100)))
}

// 上传任务行：UploadPanel 列表与 UploadQueue 浮层共用。
// 行内动作：失败可重试（以原 File 快照重开确认弹窗，重新校验目标/限额），
// 成功可复制落地绝对路径（每行一个，clipboard 不可用时明确报错）
export function UploadJobCard({ job, surface = 'panel' }: { job: UploadJob; surface?: 'panel' | 'float' }) {
  const { t } = useTranslation()
  const removeUploadJob = useConsoleStore((s) => s.removeUploadJob)
  const openUploadDialog = useConsoleStore((s) => s.openUploadDialog)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const LeadIcon = job.files.length ? CATEGORY_ICON[fileCategory(job.files[0])] : null
  const percent = job.status === 'success' ? 100 : formatPercent(job.loadedBytes, job.totalBytes)
  const statusText =
    job.status === 'error'
      ? t('uploadQueue.failed')
      : job.status === 'success'
        ? t('uploadQueue.done')
        : job.status === 'queued'
          ? t('uploadQueue.queued')
          : `${percent}%`

  // 重试=以原快照重开确认弹窗（重新校验限额/目标）。replacesJobId 交给弹窗在
  // 新任务真正提交后再删旧失败记录——用户取消或校验失败时错误记录仍在
  const retry = () => {
    if (!job.sourceFiles?.length) return
    openUploadDialog({
      files: job.sourceFiles,
      hostId: job.hostId,
      preferredRootId: job.targetRootId,
      preferredPath: job.targetPath,
      insertPaths: job.insertPaths,
      replacesJobId: job.id,
    })
  }
  const copyPaths = async () => {
    const paths = job.result?.files.map((file) => file.absolutePath) || []
    if (!paths.length) return
    try {
      await navigator.clipboard.writeText(paths.join('\n'))
      pushToast({ type: 'success', message: t('uploadQueue.copied', { count: paths.length }) })
    } catch {
      pushToast({ type: 'error', message: t('uploadQueue.copyFailed') })
    }
  }

  return (
    <div
      className={
        surface === 'float'
          ? 'tmuxgo-float-surface pointer-events-auto p-3'
          : 'rounded-apple border border-[var(--line)] bg-bg-0 p-2.5'
      }
    >
      <div className="flex items-start gap-3">
        {LeadIcon && <LeadIcon aria-hidden="true" size={14} className="mt-0.5 shrink-0 text-text-3" />}
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-text-1">
            {job.files.length === 1 ? job.files[0]?.name : `${job.files[0]?.name || 'files'} +${job.files.length - 1}`}
          </div>
          <div className="mt-0.5 truncate text-meta text-text-3">{job.targetPath || '/'}</div>
        </div>
        <div
          className={`shrink-0 text-meta ${job.status === 'error' ? 'text-danger' : job.status === 'success' ? 'text-accent-2' : 'text-accent'}`}
        >
          {statusText}
        </div>
      </div>
      <div className="tmuxgo-progress mt-2">
        <div
          className={`tmuxgo-progress-bar ${job.status === 'error' ? 'tmuxgo-progress-bar--danger' : job.status === 'success' ? 'tmuxgo-progress-bar--success' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-meta text-text-3">
        <div>
          {formatFileSize(job.loadedBytes)} / {formatFileSize(job.totalBytes)}
        </div>
        <div className="flex items-center gap-3">
          {job.status === 'error' && !!job.sourceFiles?.length && (
            <button type="button" className="text-accent hover:text-text-1" onClick={retry}>
              {t('uploadQueue.retry')}
            </button>
          )}
          {job.status === 'success' && !!job.result?.files?.length && (
            <button type="button" className="text-text-3 hover:text-text-1" onClick={() => void copyPaths()}>
              {t('uploadQueue.copyPaths')}
            </button>
          )}
          <button type="button" className="text-text-3 hover:text-text-1" onClick={() => removeUploadJob(job.id)}>
            {t('uploadQueue.close')}
          </button>
        </div>
      </div>
      {job.errorMessage && <div className="mt-1.5 line-clamp-2 text-meta text-danger">{job.errorMessage}</div>}
    </div>
  )
}
