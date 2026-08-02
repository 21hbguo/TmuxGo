'use client'

import { useEffect, useRef } from 'react'
import { useSystemTasks } from '@/hooks/useApi'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { fetchApiBlob } from '@/lib/api'

export function TaskNotifications() {
  const { data } = useSystemTasks(true, true)
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const queryClient = useOptionalQueryClient()
  const statusesRef = useRef(new Map<string, string>())
  const initializedRef = useRef(false)
  useEffect(() => {
    const tasks = data?.tasks
    if (!tasks) return
    const previousStatuses = statusesRef.current
    const nextStatuses = new Map(tasks.map((task) => [task.id, task.status]))
    if (!initializedRef.current) {
      statusesRef.current = nextStatuses
      initializedRef.current = true
      return
    }
    tasks.forEach((task) => {
      if (previousStatuses.get(task.id) === task.status || task.status !== 'success' && task.status !== 'error') return
      const message = task.status === 'success' ? t('tasks.notificationSuccess', { title: task.title }) : t('tasks.notificationFailed', { title: task.title, message: task.errorMessage || t('tasks.status.error') })
      if (task.status === 'success' && task.type.startsWith('git-')) queryClient?.invalidateQueries({ queryKey: ['git-status'] })
      if (task.type === 'host-test') queryClient?.invalidateQueries({ queryKey: ['hosts'] })
      const result = task.result && typeof task.result === 'object' ? task.result as { downloadUrl?: unknown; fileName?: unknown } : null
      if (task.status === 'success' && task.type === 'file-download' && result && typeof result.downloadUrl === 'string' && result.downloadUrl.startsWith('/api/') && typeof result.fileName === 'string') {
        void fetchApiBlob(result.downloadUrl).then((blob) => {
          const objectUrl = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = objectUrl
          anchor.download = result.fileName as string
          anchor.rel = 'noopener'
          anchor.style.display = 'none'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
        }).catch(() => {})
      }
      pushToast({ type: task.status === 'success' ? 'success' : 'error', message })
      if (document.visibilityState !== 'hidden' || !window.matchMedia('(max-width: 1023px)').matches || !('Notification' in window) || Notification.permission !== 'granted') return
      const notification = new Notification(t('tasks.title'), { body: message, tag: `task:${task.id}:${task.attempt || 1}` })
      notification.onclick = () => {
        window.focus()
        notification.close()
        window.dispatchEvent(new CustomEvent('tmuxgo-open-tasks'))
      }
    })
    statusesRef.current = nextStatuses
  }, [data, pushToast, queryClient, t])
  return null
}
