'use client'

import { useState } from 'react'
import { FiMoreHorizontal, FiPlus, FiTrash2 } from 'react-icons/fi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { useBatchKillWindows, useCreateWindow, useSessionSnapshot, useWindows } from '@/hooks/useApi'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useTranslation } from '@/i18n'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { summarizeAgentByWindow } from '@/lib/agent-status'

export function WindowTabs() {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const { data: windows = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', activeSessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', activeSessionId || '')
  const { syncAfterWindowChange } = useSessionSnapshotSync()
  const createWindow = useCreateWindow()
  const batchKillWindows = useBatchKillWindows()
  const { t } = useTranslation()

  const [batchMode, setBatchMode] = useState(false)
  const [selectedWindowIds, setSelectedWindowIds] = useState<string[]>([])
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false)
  const [newWindowPromptOpen, setNewWindowPromptOpen] = useState(false)
  const [newWindowName, setNewWindowName] = useState('')

  if (!activeSessionId || windows.length === 0) {
    return null
  }

  const sessionWindows = windows.filter((w: any) => w.sessionId === activeSessionId)
  if (sessionWindows.length === 0) {
    return null
  }
  const windowRollups = new Map(summarizeAgentByWindow(snapshotData?.panes || []).map((rollup) => [rollup.windowId, rollup]))

  const handleSelect = async (windowId: string) => {
    if (!activeHostId || !activeSessionId) return
    const previousWindows = getWindows()
    setWindows(previousWindows.map((window: any) => window.sessionId === activeSessionId ? { ...window, active: window.id === windowId } : window))
    try {
      const result = await api.windows.select(activeHostId, activeSessionId, windowId)
      if (result.windows) setWindows(result.windows)
      await syncAfterWindowChange()
    } catch (err) {
      setWindows(previousWindows)
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.switchFailed') })
    }
  }

  const handleOpenNewWindowPrompt = () => {
    if (!activeHostId || !activeSessionId) {
      pushToast({ type: 'error', message: t('window.createMissingSession') })
      return
    }
    if (batchMode) {
      setBatchMode(false)
      setSelectedWindowIds([])
    }
    setNewWindowName(`win-${sessionWindows.length + 1}`)
    setNewWindowPromptOpen(true)
  }

  const confirmCreateWindow = async (inputName?: string) => {
    if (!activeHostId || !activeSessionId) {
      setNewWindowPromptOpen(false)
      return
    }
    const name = (typeof inputName === 'string' ? inputName : newWindowName || '').trim() || 'new-window'
    try {
      const created = await createWindow.mutateAsync({ hostId: activeHostId, sessionId: activeSessionId, name })
      if (created?.id) {
        const selected = await api.windows.select(activeHostId, activeSessionId, created.id)
        if (selected?.windows) setWindows(selected.windows)
        else {
          const latest = await api.windows.list(activeHostId, activeSessionId)
          if (Array.isArray(latest)) setWindows(latest)
        }
      }
      await syncAfterWindowChange()
      pushToast({ type: 'success', message: t('window.created', { name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.createFailed') })
    }
    setNewWindowPromptOpen(false)
  }

  const toggleBatchMode = () => {
    const next = !batchMode
    setBatchMode(next)
    if (!next) setSelectedWindowIds([])
  }

  const toggleBatchSelection = (windowId: string) => {
    setSelectedWindowIds((prev) => prev.includes(windowId) ? prev.filter((id) => id !== windowId) : [...prev, windowId])
  }

  const nonActiveIds = sessionWindows.filter((w: any) => !w.active).map((w: any) => w.id)

  const handleBatchDelete = async () => {
    if (!activeHostId || !activeSessionId || selectedWindowIds.length === 0) return
    try {
      const results = await batchKillWindows.mutateAsync({ hostId: activeHostId, sessionId: activeSessionId, windowIds: selectedWindowIds })
      const success = results.filter((r) => r.ok).length
      const failed = results.length - success
      if (failed === 0) {
        pushToast({ type: 'success', message: t('window.batchDeleteSuccess', { count: success }) })
      } else if (success > 0) {
        pushToast({ type: 'error', message: t('window.batchDeletePartial', { success, failed }) })
      } else {
        pushToast({ type: 'error', message: t('window.batchDeleteFailed', { count: failed }) })
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.batchDeleteFailed', { count: selectedWindowIds.length }) })
    } finally {
      setPendingBatchDelete(false)
      setBatchMode(false)
      setSelectedWindowIds([])
    }
  }

  return (
    <div className="flex items-center gap-1 border-b border-[var(--line)] bg-bg-1 px-2 py-1">
      {batchMode && (
        <div className="flex shrink-0 items-center gap-1 border-r border-[var(--line)] pr-2">
          <Chip onClick={() => setSelectedWindowIds(nonActiveIds)} className="whitespace-nowrap px-2 py-1 text-xs" disabled={nonActiveIds.length === 0}>{t('window.batchSelectAll')}</Chip>
          <Chip onClick={() => setSelectedWindowIds([])} className="whitespace-nowrap px-2 py-1 text-xs" disabled={selectedWindowIds.length === 0}>{t('window.batchClearAll')}</Chip>
          <Chip tone="danger" onClick={() => setPendingBatchDelete(true)} className="flex items-center gap-1 whitespace-nowrap px-2 py-1 text-xs" disabled={selectedWindowIds.length === 0}>
            <FiTrash2 aria-hidden="true" size={11} />{t('window.batchDeleteSelected', { count: selectedWindowIds.length })}
          </Chip>
          <Chip onClick={toggleBatchMode} className="whitespace-nowrap px-2 py-1 text-xs">{t('window.batchCancel')}</Chip>
        </div>
      )}
      <div className="tmuxgo-scrollbar-subtle flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {sessionWindows.map((window: any) => {
          if (batchMode) {
            if (window.active) {
              return (
                <Chip key={window.id} tone="accent" className="whitespace-nowrap px-3 py-1.5 text-sm opacity-60" title={t('window.cannotDeleteActive')}>{window.name}</Chip>
              )
            }
            const selected = selectedWindowIds.includes(window.id)
            return (
              <Chip key={window.id} tone={selected ? 'danger' : 'default'} onClick={() => toggleBatchSelection(window.id)} className="whitespace-nowrap px-3 py-1.5 text-sm">
                <span className="mr-1">{selected ? '☑' : '☐'}</span>{window.name}
              </Chip>
            )
          }
          return (
            <Chip key={window.id} tone={window.active ? 'accent' : 'default'} onClick={() => handleSelect(window.id)} className="whitespace-nowrap transition-colors px-3 py-1.5 text-sm">
              <span className="mr-1">{window.name}</span>
              <WindowAgentRollupBadge windowId={window.id} rollups={windowRollups} />
            </Chip>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Chip onClick={handleOpenNewWindowPrompt} className="px-2 py-1.5" title={t('window.createTitle')} aria-label={t('window.createTitle')} disabled={createWindow.isPending}>
          <FiPlus aria-hidden="true" size={13} />
        </Chip>
        <Chip onClick={toggleBatchMode} className={`px-2 py-1.5 ${batchMode ? 'tmuxgo-chip--accent' : ''}`} title={t(batchMode ? 'window.batchCancel' : 'window.batchMode')} aria-label={t(batchMode ? 'window.batchCancel' : 'window.batchMode')}>
          <FiMoreHorizontal aria-hidden="true" size={13} />
        </Chip>
      </div>
      <PromptDialog open={newWindowPromptOpen} title={t('window.createTitle')} defaultValue={newWindowName} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} onCancel={() => setNewWindowPromptOpen(false)} onConfirm={(value) => { setNewWindowName(value); void confirmCreateWindow(value) }} />
      <ConfirmDialog open={pendingBatchDelete} title={t('window.batchDeleteTitle')} message={t('window.batchDeleteConfirm', { count: selectedWindowIds.length })} confirmLabel={t('window.batchDeleteSelected', { count: selectedWindowIds.length })} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingBatchDelete(false)} onConfirm={() => void handleBatchDelete()} />
    </div>
  )
}

function WindowAgentRollupBadge({ windowId, rollups }: { windowId: string; rollups: Map<string, ReturnType<typeof summarizeAgentByWindow>[number]> }) {
  const rollup = rollups.get(windowId)
  if (!rollup || !rollup.summary.total) return null
  const { t } = useTranslation()
  const parts = rollup.statuses.map((status) => <span key={status} className={`inline-flex items-center gap-0.5 ${status === 'blocked' ? 'text-danger' : status === 'done' ? 'text-accent-2' : status === 'working' ? 'text-accent' : 'text-text-3'}`} title={t(`agent.status.${status}`)}>{rollup.summary[status]}<span className="text-[0.65em] opacity-70">{t(`agent.status.${status}`).slice(0, 1).toLowerCase()}</span></span>)
  return <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-text-1/10 bg-bg-2/50 px-1.5 py-0.5 font-mono text-caption tabular-nums">{parts}</span>
}
