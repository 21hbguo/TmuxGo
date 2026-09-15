'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useBatchDeleteSessions, useCreateSession, useDeleteSession, useRenameSession, useWindows } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { useMigrateSessionWorkspace, useRemoveSessionWorkspaces, useSetSessionWorkspace } from '@/hooks/useSessionWorkspaces'
import { useWorkspaces } from '@/hooks/useWorkspaces'
import { SessionTemplates, type Template } from './SessionTemplates'
import { CreateSessionDialog } from './CreateSessionDialog'
import { ModalPortal } from './ModalPortal'
import { getTemplateSessionName } from '@/lib/session-template'
import { useTranslation } from '@/i18n'
import { FiPlus, FiTrash2 } from 'react-icons/fi'
import { Button } from './Button'
import { Chip } from './Chip'
import { usePrompt } from '@/hooks/usePrompt'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { useBatchKillWindows, useCreateWindow } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { QuickActions } from './QuickActions'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { SessionSortableList } from './SessionSortableList'
import { HostSwitcher } from './HostSwitcher'
import { AgentStatusBadge } from './AgentStatusBadge'

function getNextSessionId(sessions: { id: string }[], removedIds: string[]) {
  const removed = new Set(removedIds)
  return sessions.find((item) => !removed.has(item.id))?.id || ''
}
function sameIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

interface MobileDrawerProps {
  isOpen: boolean
  onClose: () => void
  type: 'sessions' | 'panes' | 'windows'
}

export function MobileDrawer({ isOpen, onClose, type }: MobileDrawerProps) {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const { data: workspaces = [] } = useWorkspaces(activeHostId || undefined)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: sessions = [], moveSession, isError: sessionsError, error: sessionsErrorValue, refetch: refetchSessions } = useOrderedSessions(activeHostId || '')
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', activeSessionId || '')
  const createWindow = useCreateWindow()
  const batchKillWindows = useBatchKillWindows()
  const createSession = useCreateSession()
  const renameSession = useRenameSession()
  const deleteSession = useDeleteSession()
  const batchDeleteSessions = useBatchDeleteSessions()
  const setSessionWorkspace = useSetSessionWorkspace()
  const removeSessionWorkspaces = useRemoveSessionWorkspaces()
  const migrateSessionWorkspace = useMigrateSessionWorkspace()
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const [showTemplates, setShowTemplates] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const [createDialogTemplate, setCreateDialogTemplate] = useState<Template | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [windowBatchMode, setWindowBatchMode] = useState(false)
  const [selectedWindowIds, setSelectedWindowIds] = useState<string[]>([])
  const [windowBatchDeleteConfirmOpen, setWindowBatchDeleteConfirmOpen] = useState(false)
  const [newWindowPromptOpen, setNewWindowPromptOpen] = useState(false)
  const [newWindowName, setNewWindowName] = useState('')

  const handleTemplateSelect = (template: Template) => {
    if (!activeHostId) return
    setShowTemplates(false)
    setCreateDialogTemplate(template)
    setCreateDialogOpen(true)
  }
  const handleCreateSession = async ({ name, cwd, workspace }: { name: string; cwd?: string; workspace?: { rootId: string; rootPath: string; rootLabel: string; relativePath: string; absolutePath: string; workspaceId?: string; workspaceName?: string } }) => {
    if (!activeHostId || !createDialogTemplate) return
    try {
      const created = await createSession.mutateAsync({ hostId: activeHostId, name, layout: createDialogTemplate.layout, cwd })
      if (created?.id) {
        if (cwd && workspace) {
          try {
            await setSessionWorkspace.mutateAsync({
              sessionId: created.id,
              hostId: activeHostId,
              workspaceId: workspace.workspaceId,
              workspacePath: workspace.absolutePath,
              rootId: workspace.rootId,
              rootPath: workspace.rootPath,
              rootLabel: workspace.rootLabel,
              relativePath: workspace.relativePath,
              updatedAt: new Date().toISOString(),
            })
          } catch {}
        }
        setActiveSession(created.id)
        pushToast({ type: 'success', message: t('session.created', { name }) })
        onClose()
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
      throw err
    }
    setCreateDialogOpen(false)
    setCreateDialogTemplate(null)
  }
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const startYRef = useRef(0)
  const translateYRef = useRef(0)
  const panelRef = useRef<HTMLDivElement>(null)

  const resetPanelPosition = useCallback(() => {
    if (!panelRef.current) return
    panelRef.current.style.removeProperty('transition-duration')
    panelRef.current.style.removeProperty('transform')
  }, [])

  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    if (isOpen) {
      setVisible(true)
      setClosing(false)
      document.body.style.overflow = 'hidden'
    } else if (visible) {
      setClosing(true)
      timer = setTimeout(() => {
        setVisible(false)
        setClosing(false)
        resetPanelPosition()
      }, 200)
      document.body.style.overflow = ''
    }
    return () => {
      if (timer) clearTimeout(timer)
      document.body.style.overflow = ''
    }
  }, [isOpen, visible, resetPanelPosition])
  useEffect(() => {
    if (!visible) return
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (!isOpen) {
        setVisible(false)
        setClosing(false)
        resetPanelPosition()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [isOpen, visible, resetPanelPosition])

  const handleClose = useCallback(() => {
    if (!isOpen) return
    resetPanelPosition()
    onClose()
  }, [isOpen, onClose, resetPanelPosition])

  const handleTouchStart = (e: React.TouchEvent) => {
    startYRef.current = e.touches[0].clientY
    translateYRef.current = 0
    if (panelRef.current) panelRef.current.style.setProperty('transition-duration', '0ms')
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    const dy = Math.max(0, e.touches[0].clientY - startYRef.current)
    translateYRef.current = dy
    if (panelRef.current) panelRef.current.style.transform = `translateY(${dy}px)`
  }

  const handleTouchEnd = () => {
    if (translateYRef.current > 80) {
      handleClose()
      return
    }
    resetPanelPosition()
  }
  const handleRenameSession = async (sessionId: string) => {
    if (!activeHostId) return
    const session = sessions.find((item: any) => item.id === sessionId)
    const name = await prompt(t('drawer.renamePrompt'), session?.name || '')
    if (!name || name === session?.name) return
    try {
      const renamed = await renameSession.mutateAsync({ hostId: activeHostId, sessionId, name })
      if (renamed?.id && renamed.id !== sessionId) { try { await migrateSessionWorkspace.mutateAsync({ fromId: sessionId, toId: renamed.id }) } catch {} }
      if (activeSessionId === sessionId && renamed?.id) setActiveSession(renamed.id)
      pushToast({ type: 'success', message: t('session.renamed', { from: session?.name || sessionId, to: name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
  }
  const confirmDeleteSession = async () => {
    if (!activeHostId || !pendingDeleteSessionId) return
    const session = sessions.find((item: any) => item.id === pendingDeleteSessionId)
    try {
      await deleteSession.mutateAsync({ hostId: activeHostId, sessionId: pendingDeleteSessionId })
      try { await removeSessionWorkspaces.mutateAsync([pendingDeleteSessionId]) } catch {}
      if (activeSessionId === pendingDeleteSessionId) setActiveSession(getNextSessionId(sessions, [pendingDeleteSessionId]))
      pushToast({ type: 'success', message: t('session.deleted', { name: session?.name || pendingDeleteSessionId }) })
      onClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setPendingDeleteSessionId(null)
  }
  const confirmBatchDeleteSession = async () => {
    if (!activeHostId || !selectedSessionIds.length) return
    try {
      const preview = await batchDeleteSessions.mutateAsync({ hostId: activeHostId, payload: { mode: 'preview', sessionIds: selectedSessionIds, filters: { includeAttached: true } } })
      const execute = await batchDeleteSessions.mutateAsync({ hostId: activeHostId, payload: { mode: 'execute', sessionIds: selectedSessionIds, filters: { includeAttached: true }, force: preview.forceRequired === true } })
      const deletedIds = new Set((execute.deleted || []).map((item) => item.sessionId))
      const deletedCount = typeof execute.deletedCount === 'number' ? execute.deletedCount : deletedIds.size
      if (deletedIds.size) { try { await removeSessionWorkspaces.mutateAsync(Array.from(deletedIds)) } catch {} }
      if (activeSessionId && deletedIds.has(activeSessionId)) setActiveSession(getNextSessionId(sessions, Array.from(deletedIds)))
      pushToast({ type: 'success', message: t('sidebar.batchDeleteSuccess', { count: deletedCount }) })
      setSelectedSessionIds([])
      setBatchMode(false)
      onClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setBatchDeleteConfirmOpen(false)
  }
  const toggleBatchSession = (sessionId: string) => {
    setSelectedSessionIds((prev) => prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId])
  }
  useEffect(() => {
    setSelectedSessionIds((prev) => {
      const next = prev.filter((id) => sessions.some((item) => item.id === id))
      return sameIds(prev, next) ? prev : next
    })
  }, [sessions])

  const sessionWindows = windowsData.filter((w: any) => w.sessionId === activeSessionId)
  const handleSelectWindow = async (windowId: string) => {
    if (!activeHostId || !activeSessionId) return
    const previousWindows = getWindows()
    setWindows(previousWindows.map((w: any) =>
      w.sessionId === activeSessionId ? { ...w, active: w.id === windowId } : w
    ))
    try {
      const result = await api.windows.select(activeHostId, activeSessionId, windowId)
      if (result.windows) setWindows(result.windows)
    } catch {
      setWindows(previousWindows)
      pushToast({ type: 'error', message: t('window.switchFailed') })
    }
    handleClose()
  }
  const handleOpenNewWindowPrompt = () => {
    if (!activeHostId || !activeSessionId) {
      pushToast({ type: 'error', message: t('window.createMissingSession') })
      return
    }
    if (windowBatchMode) {
      setWindowBatchMode(false)
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
      }
      pushToast({ type: 'success', message: t('window.created', { name }) })
      handleClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.createFailed') })
    }
    setNewWindowPromptOpen(false)
  }
  const toggleWindowBatchMode = () => {
    const next = !windowBatchMode
    setWindowBatchMode(next)
    if (!next) setSelectedWindowIds([])
  }
  const toggleWindowSelection = (windowId: string) => {
    setSelectedWindowIds((prev) => prev.includes(windowId) ? prev.filter((id) => id !== windowId) : [...prev, windowId])
  }
  const handleWindowBatchDelete = async () => {
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
      setWindowBatchDeleteConfirmOpen(false)
      setWindowBatchMode(false)
      setSelectedWindowIds([])
    }
  }
  useEffect(() => {
    if (isOpen && type === 'sessions') return
    setBatchMode(false)
    setSelectedSessionIds([])
    setBatchDeleteConfirmOpen(false)
    setWindowBatchMode(false)
    setSelectedWindowIds([])
    setWindowBatchDeleteConfirmOpen(false)
  }, [isOpen, type])

  if (!visible) return null

  return (
    <div className="fixed left-0 right-0 top-0 z-50" style={{ height: 'var(--app-height,100dvh)' }}>
      <div
        className={`tmuxgo-scrim absolute inset-0 transition-opacity duration-200 ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={handleClose}
      />
      <div
        ref={panelRef}
        className={`tmuxgo-glass tmuxgo-glass-dialog absolute bottom-0 left-0 right-0 flex max-h-[75%] flex-col overflow-hidden border-t transition-transform duration-200 ease-out ${closing ? 'translate-y-full' : ''}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom,0px)' }}
      >
        <div className="flex justify-center py-2 touch-none" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchEnd}>
          <div className="w-10 h-1 rounded-full bg-text-3/30" />
        </div>
        <div className="flex items-center justify-between px-4 pb-3">
          <h3 className="text-text-1 font-medium">
            {type === 'sessions' ? batchMode ? t('sidebar.batchSelectedCount', { count: selectedSessionIds.length }) : t('drawer.sessions') : type === 'windows' ? t('drawer.windowsTitle') : t('drawer.panes')}
          </h3>
          <div className="flex items-center gap-2">
            {type === 'sessions' && <Chip onClick={() => {
              setBatchMode((prev) => !prev)
              setSelectedSessionIds([])
            }}>{batchMode ? t('sidebar.batchCancelAction') : t('sidebar.batchDeleteAction')}</Chip>}
            {type === 'windows' && !windowBatchMode && <Chip onClick={handleOpenNewWindowPrompt} aria-label={t('window.createTitle')} title={t('window.createTitle')} disabled={createWindow.isPending}><FiPlus aria-hidden="true" size={14} /></Chip>}
            {type === 'windows' && <Chip onClick={toggleWindowBatchMode}>{windowBatchMode ? t('window.batchCancel') : t('window.batchMode')}</Chip>}
            <Button variant="ghost" size="icon-sm" aria-label="close" onClick={handleClose}>✕</Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-4 scrollbar-none" style={{ WebkitOverflowScrolling: 'touch' }}>
          {type === 'sessions' && (
            <div className="space-y-2">
              <HostSwitcher mode="mobile" />
              {!batchMode && <Chip
                onClick={() => setShowTemplates(true)}
                className="w-full justify-start p-3 border border-dashed"
              >
                + {t('sidebar.newSession')}
              </Chip>}
              {batchMode && <div className="grid grid-cols-3 gap-2">
                <Chip onClick={() => setSelectedSessionIds(sessions.map((session) => session.id))} className="flex-1 justify-center">{t('sidebar.batchSelectAll')}</Chip>
                <Chip onClick={() => setSelectedSessionIds([])} className="flex-1 justify-center">{t('sidebar.batchClearAll')}</Chip>
                <Chip tone="danger" disabled={!selectedSessionIds.length} className="flex-1 justify-center disabled:cursor-not-allowed" onClick={() => setBatchDeleteConfirmOpen(true)}>{t('sidebar.batchDeleteSelected')}</Chip>
              </div>}
              {sessionsError && !sessions.length ? <div className="rounded-apple bg-bg-2 p-3 text-xs text-danger"><div className="break-words">{sessionsErrorValue instanceof Error ? sessionsErrorValue.message : t('session.loadFailed')}</div><button onClick={() => void refetchSessions()} className="mt-2 rounded-apple bg-bg-1 px-2 py-1 text-accent">{t('common.retry')}</button></div> : <SessionSortableList
                sessions={sessions}
                onMove={moveSession}
                listClassName="space-y-2"
                getItemClassName={({ session, isDragging, isOverlay }) => `tmuxgo-list-row rounded-apple ${batchMode ? selectedSessionIds.includes(session.id) ? 'tmuxgo-list-row--batch' : '' : ''} ${isDragging && !isOverlay ? 'opacity-40' : ''}`}
                renderItem={({ session, isOverlay }) => (
                  <div className={`tmuxgo-list-row flex items-center gap-2 rounded-apple border p-2 ${batchMode ? selectedSessionIds.includes(session.id) ? 'tmuxgo-list-row--batch' : 'border-transparent bg-bg-2' : activeSessionId === session.id ? 'tmuxgo-list-row--active' : 'border-transparent bg-bg-2'} ${isOverlay ? 'border-accent bg-bg-1' : ''}`}>
                    {batchMode && <button onClick={() => toggleBatchSession(session.id)} className={`flex h-9 w-7 shrink-0 items-center justify-center rounded-apple text-sm leading-none ${selectedSessionIds.includes(session.id) ? 'text-danger' : 'text-text-3'} active:bg-bg-1`}>{selectedSessionIds.includes(session.id) ? '☑' : '☐'}</button>}
                    <button onClick={() => {
                      if (batchMode) {
                        toggleBatchSession(session.id)
                        return
                      }
                      setActiveSession(session.id)
                      handleClose()
                    }} className="min-w-0 flex-1 px-1 py-1 text-left">
                      <div className="truncate text-text-1">{session.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-text-3"><span className="shrink-0 whitespace-nowrap">{t('drawer.windows', { count: session.windowCount })}</span><AgentStatusBadge summary={session.agentSummary} /></div>
                    </button>
                    {!batchMode && <div className="flex shrink-0 items-center gap-1">
                      <button onClick={() => void handleRenameSession(session.id)} className="rounded-apple px-2 py-2 text-xs text-text-2 active:bg-bg-1" aria-label={t('sidebar.renameSession')} title={t('sidebar.renameSession')}>✎</button>
                      <button onClick={() => setPendingDeleteSessionId(session.id)} className="rounded-apple px-2 py-2 text-sm text-text-2 active:bg-bg-1" aria-label={t('sidebar.deleteSession')} title={t('sidebar.deleteSession')}>×</button>
                    </div>}
                  </div>
                )}
              />}
            </div>
          )}
          {type === 'panes' && (
            <QuickActions />
          )}
          {type === 'windows' && (
            <div className="space-y-2">
              {windowBatchMode && (() => {
                const nonActiveIds = sessionWindows.filter((w: any) => !w.active).map((w: any) => w.id)
                return <div className="grid grid-cols-3 gap-2">
                  <Chip onClick={() => setSelectedWindowIds(nonActiveIds)} className="flex-1 justify-center" disabled={nonActiveIds.length === 0}>{t('window.batchSelectAll')}</Chip>
                  <Chip onClick={() => setSelectedWindowIds([])} className="flex-1 justify-center" disabled={selectedWindowIds.length === 0}>{t('window.batchClearAll')}</Chip>
                  <Chip tone="danger" className="flex-1 justify-center disabled:cursor-not-allowed" disabled={selectedWindowIds.length === 0} onClick={() => setWindowBatchDeleteConfirmOpen(true)}>{t('window.batchDeleteSelected', { count: selectedWindowIds.length })}</Chip>
                </div>
              })()}
              {sessionWindows.length === 0 ? (
                <div className="text-center text-text-3 py-4">{t('drawer.noWindows')}</div>
              ) : (
                sessionWindows.map((window: any) => {
                  if (windowBatchMode) {
                    if (window.active) {
                      return (
                        <div key={window.id} className="w-full rounded-apple border border-accent/30 bg-accent/10 p-3 opacity-60">
                          <div className="truncate text-text-1">{window.name}</div>
                          <div className="text-text-3 text-xs">#{window.index + 1} · {t('window.cannotDeleteActive')}</div>
                        </div>
                      )
                    }
                    const selected = selectedWindowIds.includes(window.id)
                    return (
                      <button
                        key={window.id}
                        onClick={() => toggleWindowSelection(window.id)}
                        className={`w-full rounded-apple p-3 text-left transition-colors ${selected ? 'border border-danger bg-danger/10' : 'bg-bg-2 active:bg-bg-1'}`}
                      >
                        <div className="truncate text-text-1">{selected ? '☑ ' : '☐ '}{window.name}</div>
                        <div className="text-text-3 text-xs">#{window.index + 1}</div>
                      </button>
                    )
                  }
                  return (
                    <button
                      key={window.id}
                      onClick={() => void handleSelectWindow(window.id)}
                      className={`w-full rounded-apple p-3 text-left transition-colors ${window.active ? 'border border-accent bg-accent/10' : 'bg-bg-2 active:bg-bg-1'}`}
                    >
                      <div className="truncate text-text-1">{window.name}</div>
                      <div className="text-text-3 text-xs">#{window.index + 1}</div>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      </div>
      {showTemplates && <ModalPortal><SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} /></ModalPortal>}
      <CreateSessionDialog open={createDialogOpen} template={createDialogTemplate} defaultName={createDialogTemplate ? getTemplateSessionName(createDialogTemplate) : ''} hostId={activeHostId || ''} workspaces={workspaces} onCreate={handleCreateSession} onClose={() => { setCreateDialogOpen(false); setCreateDialogTemplate(null) }} />
      <ConfirmDialog open={!!pendingDeleteSessionId} title={t('sidebar.deleteTitle')} message={t('sidebar.deleteConfirm', { name: sessions.find((item: any) => item.id === pendingDeleteSessionId)?.name || '' })} confirmLabel={t('sidebar.confirmDelete')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDeleteSessionId(null)} onConfirm={() => void confirmDeleteSession()} />
      <ConfirmDialog open={batchDeleteConfirmOpen} title={t('sidebar.batchDeleteTitle')} message={t('sidebar.batchDeleteConfirm', { count: selectedSessionIds.length })} confirmLabel={t('sidebar.batchDeleteSelected')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setBatchDeleteConfirmOpen(false)} onConfirm={() => void confirmBatchDeleteSession()} />
      <PromptDialog open={newWindowPromptOpen} title={t('window.createTitle')} defaultValue={newWindowName} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} onCancel={() => setNewWindowPromptOpen(false)} onConfirm={(value) => { setNewWindowName(value); void confirmCreateWindow(value) }} />
      <ConfirmDialog open={windowBatchDeleteConfirmOpen} title={t('window.batchDeleteTitle')} message={t('window.batchDeleteConfirm', { count: selectedWindowIds.length })} confirmLabel={t('window.batchDeleteSelected', { count: selectedWindowIds.length })} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setWindowBatchDeleteConfirmOpen(false)} onConfirm={() => void handleWindowBatchDelete()} />
      {PromptElement}
    </div>
  )
}
