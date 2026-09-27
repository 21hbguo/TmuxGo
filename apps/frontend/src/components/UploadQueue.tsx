'use client'
import { useMemo } from 'react'
import { Chip } from './Chip'
import { UploadJobCard } from './UploadJobCard'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

export function UploadQueue() {
  const uploadJobs = useConsoleStore((s) => s.uploadJobs)
  const clearFinishedUploadJobs = useConsoleStore((s) => s.clearFinishedUploadJobs)
  const { t } = useTranslation()
  const visibleJobs = useMemo(
    () =>
      uploadJobs
        .filter((job) => job.status === 'queued' || job.status === 'uploading' || job.status === 'error')
        .slice(0, 4),
    [uploadJobs],
  )
  if (!visibleJobs.length) return null
  // 移动端抬高到底部导航栏+安全区之上，避免遮挡 MobileNav/ShortcutBar
  return (
    <div className="pointer-events-none fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-3 z-[96] flex w-[min(420px,calc(100vw-24px))] flex-col gap-2 lg:bottom-4 lg:right-4">
      <div className="tmuxgo-float-surface pointer-events-auto flex items-center justify-between px-3 py-2">
        <div className="text-xs text-text-2">{t('uploadQueue.title')}</div>
        <Chip onClick={clearFinishedUploadJobs}>{t('uploadQueue.clean')}</Chip>
      </div>
      {visibleJobs.map((job) => (
        <UploadJobCard key={job.id} job={job} surface="float" />
      ))}
    </div>
  )
}
