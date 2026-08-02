'use client'

import { useEffect, useMemo, useState } from 'react'
import { useCancelSystemTask, useRetrySystemTask, useSystemTasks } from '@/hooks/useApi'
import { useTranslation } from '@/i18n'
import { Button } from './Button'

function formatTime(value: string | null) {
  if (!value) return '-'
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toLocaleString()
}
function formatDuration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt) return '-'
  const start = Date.parse(startedAt)
  const end = Date.parse(finishedAt || '') || Date.now()
  if (Number.isNaN(start)) return '-'
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
function formatSpeed(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB/s`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`
  return `${Math.round(value)} B/s`
}
export function TaskCenter({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { data, isLoading } = useSystemTasks()
  const cancelTask = useCancelSystemTask()
  const retryTask = useRetrySystemTask()
  const tasks = data?.tasks || []
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) || tasks[0] || null, [selectedTaskId, tasks])
  useEffect(() => {
    if (selectedTask) setSelectedTaskId(selectedTask.id)
  }, [selectedTask])
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center tmuxgo-scrim p-4" onMouseDown={onClose}>
      <section className="tmuxgo-glass tmuxgo-glass-dialog flex h-[min(620px,calc(100dvh-32px))] w-full max-w-3xl flex-col overflow-hidden rounded-apple border sm:flex-row" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex h-32 w-full shrink-0 flex-col border-b border-[var(--line)] bg-bg-1 sm:h-auto sm:w-56 sm:border-b-0 sm:border-r">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-3"><h2 className="text-sm font-medium text-text-1">{t('tasks.title')}</h2><Button variant="ghost" size="icon-sm" aria-label="close" onClick={onClose}>×</Button></div>
          <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
            {tasks.map((task) => <button key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)} className={`w-full rounded-apple px-2 py-2 text-left ${selectedTask?.id === task.id ? 'bg-accent/15 text-text-1' : 'text-text-2 hover:bg-bg-2'}`}><div className="truncate text-xs font-medium">{task.title}</div><div className={`mt-1 text-caption ${task.status === 'success' ? 'text-accent-2' : task.status === 'running' ? 'text-warn' : task.status === 'error' || task.status === 'cancelled' ? 'text-danger' : 'text-text-3'}`}>{t(`tasks.status.${task.status}`)}</div></button>)}
            {!isLoading && !tasks.length && <div className="px-2 py-3 text-xs text-text-3">{t('tasks.empty')}</div>}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {!selectedTask ? <div className="flex h-full items-center justify-center text-sm text-text-3">{isLoading ? t('common.loading') : t('tasks.empty')}</div> : <>
            <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3"><div className="min-w-0"><h3 className="truncate text-sm font-medium text-text-1">{selectedTask.title}</h3><div className="mt-1 text-caption text-text-3">{t(`tasks.status.${selectedTask.status}`)} · {formatDuration(selectedTask.startedAt, selectedTask.finishedAt)}</div></div><div className="flex shrink-0 gap-2">{selectedTask.cancellable && <Button variant="danger" size="sm" disabled={cancelTask.isPending} onClick={() => void cancelTask.mutateAsync(selectedTask.id)}>{t('tasks.cancel')}</Button>}{selectedTask.retryable && <Button variant="primary" size="sm" disabled={retryTask.isPending} onClick={() => void retryTask.mutateAsync(selectedTask.id)}>{t('tasks.retry')}</Button>}</div></div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-[var(--line)] px-4 py-3 text-xs"><div><div className="text-text-3">{t('tasks.startedAt')}</div><div className="mt-1 text-text-1">{formatTime(selectedTask.startedAt)}</div></div><div><div className="text-text-3">{t('tasks.finishedAt')}</div><div className="mt-1 text-text-1">{formatTime(selectedTask.finishedAt)}</div></div>{typeof selectedTask.progress === 'number' && <div><div className="text-text-3">{t('tasks.progress')}</div><div className="mt-1 text-text-1">{selectedTask.progress}%</div></div>}{typeof selectedTask.speedBytesPerSecond === 'number' && <div><div className="text-text-3">{t('tasks.speed')}</div><div className="mt-1 text-text-1">{formatSpeed(selectedTask.speedBytesPerSecond)}</div></div>}{selectedTask.errorMessage && <div className="col-span-2"><div className="text-text-3">{t('tasks.error')}</div><div className="mt-1 text-danger">{selectedTask.errorMessage}</div></div>}{selectedTask.resultMessage && <div className="col-span-2"><div className="text-text-3">{t('tasks.result')}</div><div className="mt-1 text-text-1">{selectedTask.resultMessage}</div></div>}</div>
            <div className="min-h-0 flex-1 p-4"><div className="mb-2 text-xs text-text-3">{t('tasks.logs')}</div><div className="tmuxgo-scrollbar h-full overflow-auto rounded-apple border border-[var(--line)] bg-bg-0 p-3 font-mono text-xs leading-5 text-text-2">{selectedTask.summaryLines.length ? selectedTask.summaryLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>) : <div className="text-text-3">{t('tasks.noLogs')}</div>}</div></div>
          </>}
        </div>
      </section>
    </div>
  )
}
