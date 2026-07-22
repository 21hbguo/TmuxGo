'use client'
import { useEffect, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useBatchDeleteSessions, useCreateSession, useDeleteSession, useRenameSession } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { SessionTemplates, type Template } from './SessionTemplates'
import { getTemplateSessionName } from '@/lib/session-template'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { QuickActions } from './QuickActions'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { usePrompt } from '@/hooks/usePrompt'
import { SessionSortableList } from './SessionSortableList'
import { HostSwitcher } from './HostSwitcher'
import { AgentStatusBadge } from './AgentStatusBadge'
import { ModalPortal } from './ModalPortal'

function getNextSessionId(sessions: { id: string }[], removedIds: string[]) {
  const removed = new Set(removedIds)
  return sessions.find((item) => !removed.has(item.id))?.id || ''
}

export function SessionPanel() {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: sessions = [], moveSession, isError, error, refetch } = useOrderedSessions(activeHostId || '')
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const batchDeleteSessions = useBatchDeleteSessions()
  const renameSession = useRenameSession()
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const [showTemplates, setShowTemplates] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const handleTemplateSelect = async (template: Template) => {
    if (!activeHostId) return
    const name = await prompt(t('drawer.sessionName'), getTemplateSessionName(template))
    if (!name) {
      setShowTemplates(false)
      return
    }
    try {
      const created = await createSession.mutateAsync({ hostId: activeHostId, name, layout: template.layout })
      if (created?.id) {
        setActiveSession(created.id)
        pushToast({ type: 'success', message: t('session.created', { name }) })
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setShowTemplates(false)
  }
  const confirmDeleteSession = async () => {
    if (!activeHostId || !pendingDeleteSessionId) return
    const session = sessions.find((item) => item.id === pendingDeleteSessionId)
    try {
      await deleteSession.mutateAsync({ hostId: activeHostId, sessionId: pendingDeleteSessionId })
      if (activeSessionId === pendingDeleteSessionId) setActiveSession(getNextSessionId(sessions, [pendingDeleteSessionId]))
      pushToast({ type: 'success', message: t('session.deleted', { name: session?.name || pendingDeleteSessionId }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setPendingDeleteSessionId(null)
  }
  const confirmBatchDeleteSession = async () => {
    if (!activeHostId || !selectedSessionIds.length) return
    try {
      const preview = await batchDeleteSessions.mutateAsync({ hostId: activeHostId, payload: { mode: 'preview', sessionIds: selectedSessionIds } })
      const execute = await batchDeleteSessions.mutateAsync({ hostId: activeHostId, payload: { mode: 'execute', sessionIds: selectedSessionIds, force: preview.forceRequired === true } })
      const deletedIds = new Set((execute.deleted || []).map((item) => item.sessionId))
      const deletedCount = typeof execute.deletedCount === 'number' ? execute.deletedCount : deletedIds.size
      if (activeSessionId && deletedIds.has(activeSessionId)) setActiveSession(getNextSessionId(sessions, Array.from(deletedIds)))
      pushToast({ type: 'success', message: t('sidebar.batchDeleteSuccess', { count: deletedCount }) })
      setSelectedSessionIds([])
      setBatchMode(false)
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setBatchDeleteConfirmOpen(false)
  }
  const handleRenameSession = async (sessionId: string) => {
    if (!activeHostId) return
    const session = sessions.find((item) => item.id === sessionId)
    const name = await prompt(t('drawer.renamePrompt'), session?.name || '')
    if (!name || name === session?.name) return
    try {
      const renamed = await renameSession.mutateAsync({ hostId: activeHostId, sessionId, name })
      if (activeSessionId === sessionId && renamed?.id) setActiveSession(renamed.id)
      pushToast({ type: 'success', message: t('session.renamed', { from: session?.name || sessionId, to: name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
  }
  const toggleBatchMode = () => {
    setBatchMode((prev) => !prev)
    setSelectedSessionIds([])
  }
  const toggleBatchSession = (sessionId: string) => {
    setSelectedSessionIds((prev) => prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId])
  }
  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])
  useEffect(() => {
    setSelectedSessionIds((prev) => prev.filter((id) => sessions.some((item) => item.id === id)))
  }, [sessions])
  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-transparent">
        <div className="border-b border-[var(--line)] px-3 py-2">
          <HostSwitcher />
          <div className="mt-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-text-1">{batchMode ? t('sidebar.batchSelectedCount', { count: selectedSessionIds.length }) : t('sidebar.sessions')}</div>
            <div className="flex items-center gap-1">
              {batchMode ? (
                <>
                  <Chip onClick={() => setSelectedSessionIds(sessions.map((session) => session.id))}>{t('sidebar.batchSelectAll')}</Chip>
                  <Chip onClick={() => setSelectedSessionIds([])}>{t('sidebar.batchClearAll')}</Chip>
                  <Chip tone="danger" disabled={!selectedSessionIds.length} onClick={() => setBatchDeleteConfirmOpen(true)}>{t('sidebar.batchDeleteSelected')}</Chip>
                  <Chip tone="accent" onClick={toggleBatchMode}>{t('sidebar.batchCancelAction')}</Chip>
                </>
              ) : (
                <>
                  <Chip tone="accent" onClick={() => setShowTemplates(true)}>{t('sidebar.newAction')}</Chip>
                  <Chip onClick={toggleBatchMode}>{t('sidebar.batchDeleteAction')}</Chip>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isError ? <div className="p-3 text-xs text-danger"><div className="break-words">{error instanceof Error ? error.message : t('session.loadFailed')}</div><button onClick={() => void refetch()} className="mt-2 rounded-apple bg-bg-2 px-2 py-1 text-accent hover:text-text-1">{t('common.retry')}</button></div> : <SessionSortableList
            sessions={sessions}
            onMove={moveSession}
            listClassName="min-h-full"
            getItemClassName={({ session, isDragging, isOverlay }) => `border-b border-[rgba(255,255,255,0.03)] ${batchMode ? selectedSessionIds.includes(session.id) ? 'bg-red-900/15' : 'hover:bg-bg-2/60' : activeSessionId === session.id ? 'bg-bg-2/80' : 'hover:bg-bg-2/60'} ${isDragging && !isOverlay ? 'opacity-40' : ''} ${isOverlay ? 'rounded-apple border border-accent bg-bg-1 shadow-[0_20px_48px_rgba(0,0,0,0.42)]' : ''}`}
            renderItem={({ session }) => (
              <div className="flex items-center gap-1 pr-2">
                {batchMode && <button onClick={() => toggleBatchSession(session.id)} className={`ml-2 flex h-7 w-5 shrink-0 items-center justify-center rounded-apple text-[11px] leading-none ${selectedSessionIds.includes(session.id) ? 'text-red-300' : 'text-text-3'} hover:bg-bg-0`}>{selectedSessionIds.includes(session.id) ? '☑' : '☐'}</button>}
                <button onClick={() => batchMode ? toggleBatchSession(session.id) : setActiveSession(session.id)} onDoubleClick={() => !batchMode && void handleRenameSession(session.id)} className={`min-w-0 flex-1 border-l-2 px-3 py-2 text-left ${batchMode ? selectedSessionIds.includes(session.id) ? 'border-red-400' : 'border-transparent' : activeSessionId === session.id ? 'border-accent' : 'border-transparent'}`}>
                  <div className="truncate text-sm text-text-1">{session.name}</div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-text-3"><span className="shrink-0 whitespace-nowrap">{t('sidebar.windows', { count: session.windowCount })}</span><AgentStatusBadge summary={session.agentSummary} /></div>
                </button>
                {!batchMode && <button onClick={() => void handleRenameSession(session.id)} className="rounded-apple px-1.5 py-1 text-[11px] text-text-3 hover:bg-bg-0 hover:text-text-1" aria-label={t('sidebar.renameSession')} title={t('sidebar.renameSession')}>✎</button>}
                {!batchMode && <button onClick={() => setPendingDeleteSessionId(session.id)} className="rounded-apple px-1.5 py-1 text-[11px] text-text-3 hover:bg-bg-0 hover:text-danger" aria-label={t('sidebar.deleteSession')} title={t('sidebar.deleteSession')}>×</button>}
              </div>
            )}
          />}
        </div>
        {preferences.showQuickActions && <div className="border-t border-[var(--line)] p-3"><div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-3">{t('sidebar.quickActions')}</div><QuickActions /></div>}
      </div>
      {showTemplates && <ModalPortal><SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} /></ModalPortal>}
      <ConfirmDialog open={!!pendingDeleteSessionId} title={t('sidebar.deleteTitle')} message={t('sidebar.deleteConfirm', { name: sessions.find((item) => item.id === pendingDeleteSessionId)?.name || '' })} confirmLabel={t('sidebar.confirmDelete')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDeleteSessionId(null)} onConfirm={() => void confirmDeleteSession()} />
      <ConfirmDialog open={batchDeleteConfirmOpen} title={t('sidebar.batchDeleteTitle')} message={t('sidebar.batchDeleteConfirm', { count: selectedSessionIds.length })} confirmLabel={t('sidebar.batchDeleteSelected')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setBatchDeleteConfirmOpen(false)} onConfirm={() => void confirmBatchDeleteSession()} />
      {PromptElement}
    </>
  )
}
