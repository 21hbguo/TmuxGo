'use client'
import { useMemo } from 'react'
import { Chip } from './Chip'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

function formatSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}
function formatPercent(loadedBytes: number, totalBytes: number) {
  if (!totalBytes) return 0
  return Math.max(0, Math.min(100, Math.round((loadedBytes / totalBytes) * 100)))
}
export function UploadQueue() {
  const uploadJobs = useConsoleStore((s) => s.uploadJobs)
  const removeUploadJob = useConsoleStore((s) => s.removeUploadJob)
  const clearFinishedUploadJobs = useConsoleStore((s) => s.clearFinishedUploadJobs)
  const { t } = useTranslation()
  const visibleJobs = useMemo(() => uploadJobs.filter((job) => job.status === 'queued' || job.status === 'uploading' || job.status === 'error').slice(0, 4), [uploadJobs])
  if (!visibleJobs.length) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[96] flex w-[min(420px,calc(100vw-24px))] flex-col gap-2">
      <div className="tmuxgo-float-surface pointer-events-auto flex items-center justify-between px-3 py-2">
        <div className="text-xs text-text-2">{t('uploadQueue.title')}</div>
        <Chip onClick={clearFinishedUploadJobs}>{t('uploadQueue.clean')}</Chip>
      </div>
      {visibleJobs.map((job) => {
        const percent = job.status === 'success' ? 100 : formatPercent(job.loadedBytes, job.totalBytes)
        const statusText = job.status === 'error' ? t('uploadQueue.failed') : job.status === 'success' ? t('uploadQueue.done') : job.status === 'queued' ? t('uploadQueue.queued') : `${percent}%`
        return (
          <div key={job.id} className="tmuxgo-float-surface pointer-events-auto p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-text-1">{job.files.length === 1 ? job.files[0]?.name : `${job.files[0]?.name || 'files'} +${job.files.length - 1}`}</div>
                <div className="mt-1 truncate text-meta text-text-3">{job.targetPath || '/'}</div>
              </div>
              <div className={`shrink-0 text-meta ${job.status === 'error' ? 'text-danger' : job.status === 'success' ? 'text-accent-2' : 'text-accent'}`}>{statusText}</div>
            </div>
            <div className="tmuxgo-progress mt-2">
              <div className={`tmuxgo-progress-bar ${job.status === 'error' ? 'tmuxgo-progress-bar--danger' : job.status === 'success' ? 'tmuxgo-progress-bar--success' : ''}`} style={{ width: `${percent}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between text-meta text-text-3">
              <div>{formatSize(job.loadedBytes)} / {formatSize(job.totalBytes)}</div>
              <Chip onClick={() => removeUploadJob(job.id)}>{t('uploadQueue.close')}</Chip>
            </div>
            {job.errorMessage && <div className="mt-2 line-clamp-2 text-meta text-danger">{job.errorMessage}</div>}
          </div>
        )
      })}
    </div>
  )
}
