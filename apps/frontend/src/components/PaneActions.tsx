'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useTranslation } from '@/i18n'
import { Button } from './Button'

export function PaneActions() {
  const pushToast = useConsoleStore((s) => s.pushToast)
  const { refreshSnapshot, resolveActivePaneId, resolveFreshActivePaneId } = useSessionSnapshotSync()
  const { t } = useTranslation()
  const refreshSnapshotSafely = async () => {
    try {
      await refreshSnapshot()
    } catch {}
  }

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    const initialPaneId = await resolveFreshActivePaneId()
    if (!initialPaneId) {
      pushToast({ type: 'error', message: t('pane.noActive') })
      return
    }
    try {
      await api.panes.split(initialPaneId, direction)
      await refreshSnapshotSafely()
      pushToast({ type: 'success', message: t('pane.splitSuccess') })
    } catch (err) {
      try {
        const paneId = await resolveFreshActivePaneId()
        if (!paneId || paneId === initialPaneId) throw err
        await api.panes.split(paneId, direction)
        await refreshSnapshotSafely()
        pushToast({ type: 'success', message: t('pane.splitSuccess') })
      } catch (retryErr) {
        pushToast({ type: 'error', message: retryErr instanceof Error ? retryErr.message : t('pane.splitFailed') })
      }
    }
  }

  const handleClose = async () => {
    const paneId = await resolveFreshActivePaneId()
    if (!paneId) {
      pushToast({ type: 'error', message: t('pane.noActive') })
      return
    }
    try {
      await api.panes.kill(paneId)
      await refreshSnapshotSafely()
      pushToast({ type: 'success', message: t('pane.closed') })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('pane.closeFailed') })
    }
  }

  const handleFullscreen = async () => {
    const paneId = await resolveActivePaneId()
    if (!paneId) {
      pushToast({ type: 'error', message: t('pane.noActive') })
      return
    }
    const paneElement = document.querySelector(`[data-pane-id="${paneId}"]`)
    if (paneElement) {
      paneElement.requestFullscreen?.()
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon-sm" className="text-xs" onClick={() => handleSplit('horizontal')} title={t('pane.splitH')}>
        ◧
      </Button>
      <Button variant="ghost" size="icon-sm" className="text-xs" onClick={() => handleSplit('vertical')} title={t('pane.splitV')}>
        ◨
      </Button>
      <Button variant="ghost" size="icon-sm" className="text-xs" onClick={handleFullscreen} title={t('pane.fullscreen')}>
        ⛶
      </Button>
      <div className="w-px h-4 bg-[var(--line)] mx-1" />
      <Button variant="ghost" size="icon-sm" className="text-xs text-danger" onClick={handleClose} title={t('pane.close')}>
        ×
      </Button>
    </div>
  )
}
