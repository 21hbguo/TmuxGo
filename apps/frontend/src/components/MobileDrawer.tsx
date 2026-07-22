'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useBatchDeleteSessions, useCreateSession, useDeleteSession, useRenameSession, useWindows } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { SessionTemplates, type Template } from './SessionTemplates'
import { ModalPortal } from './ModalPortal'
import { getTemplateSessionName } from '@/lib/session-template'
import { useTranslation } from '@/i18n'
import { usePrompt } from '@/hooks/usePrompt'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { api } from '@/lib/api'
import { QuickActions } from './QuickActions'
import { ConfirmDialog } from './ConfirmDialog'
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
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: sessions = [], moveSession, isError: sessionsError, error: sessionsErrorValue, refetch: refetchSessions } = useOrderedSessions(activeHostId || '')
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', activeSessionId || '')
  const createSession = useCreateSession()
  const renameSession = useRenameSession()
  const deleteSession = useDeleteSession()
  const batchDeleteSessions = useBatchDeleteSessions()
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
    if (!name) return
    try {
      const created = await createSession.mutateAsync({ hostId: activeHostId, name, layout: template.layout })
      if (created?.id) setActiveSession(created.id)
      pushToast({ type: 'success', message: t('session.created', { name }) })
      onClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setShowTemplates(false)
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
      const preview = await batchDeleteSessions.mutateAsync({ hostId: activeHostId, payload: { mode: 'preview', sessionIds: selectedSessionIds } })
      const execute = await batchDeleteSessions.mutateAsync({ hostId: activeHostId, payload: { mode: 'execute', sessionIds: selectedSessionIds, force: preview.forceRequired === true } })
      const deletedIds = new Set((execute.deleted || []).map((item) => item.sessionId))
      const deletedCount = typeof execute.deletedCount === 'number' ? execute.deletedCount : deletedIds.size
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
  useEffect(() => {
    if (isOpen && type === 'sessions') return
    setBatchMode(false)
    setSelectedSessionIds([])
    setBatchDeleteConfirmOpen(false)
  }, [isOpen, type])

  if (!visible) return null

  return (
    <div className="fixed left-0 right-0 top-0 z-50" style={{ height: 'var(--app-height,100dvh)' }}>
      <div
        className={`absolute inset-0 bg-black/35 transition-opacity duration-200 ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={handleClose}
      />
      <div
        ref={panelRef}
        className={`tmuxgo-material absolute bottom-0 left-0 right-0 flex max-h-[75%] flex-col overflow-hidden border-t transition-transform duration-200 ease-out ${closing ? 'translate-y-full' : ''}`}
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
            {type === 'sessions' && <button onClick={() => {
              setBatchMode((prev) => !prev)
              setSelectedSessionIds([])
            }} className="tmuxgo-chip">{batchMode ? t('sidebar.batchCancelAction') : t('sidebar.batchDeleteAction')}</button>}
            <button onClick={handleClose} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--icon-sm tmuxgo-icon-button">✕</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" style={{ WebkitOverflowScrolling: 'touch' }}>
          {type === 'sessions' && (
            <div className="space-y-2">
              <HostSwitcher mode="mobile" />
              {!batchMode && <button
                onClick={() => setShowTemplates(true)}
                className="tmuxgo-chip w-full justify-start p-3 border border-dashed"
              >
                + {t('sidebar.newSession')}
              </button>}
              {batchMode && <div className="grid grid-cols-3 gap-2">
                <button onClick={() => setSelectedSessionIds(sessions.map((session) => session.id))} className="tmuxgo-chip flex-1 justify-center">{t('sidebar.batchSelectAll')}</button>
                <button onClick={() => setSelectedSessionIds([])} className="tmuxgo-chip flex-1 justify-center">{t('sidebar.batchClearAll')}</button>
                <button onClick={() => setBatchDeleteConfirmOpen(true)} disabled={!selectedSessionIds.length} className="tmuxgo-chip tmuxgo-chip--danger flex-1 justify-center disabled:cursor-not-allowed">{t('sidebar.batchDeleteSelected')}</button>
              </div>}
              {sessionsError ? <div className="rounded-lg bg-bg-2 p-3 text-xs text-danger"><div className="break-words">{sessionsErrorValue instanceof Error ? sessionsErrorValue.message : t('session.loadFailed')}</div><button onClick={() => void refetchSessions()} className="mt-2 rounded bg-bg-1 px-2 py-1 text-accent">{t('common.retry')}</button></div> : <SessionSortableList
                sessions={sessions}
                onMove={moveSession}
                listClassName="space-y-2"
                getItemClassName={({ session, isDragging, isOverlay }) => `rounded-lg ${batchMode ? selectedSessionIds.includes(session.id) ? 'bg-red-900/15' : '' : ''} ${isDragging && !isOverlay ? 'opacity-40' : ''} ${isOverlay ? 'shadow-[0_20px_48px_rgba(0,0,0,0.42)]' : ''}`}
                renderItem={({ session, isOverlay }) => (
                  <div className={`flex items-center gap-2 rounded-lg p-2 transition-[transform,box-shadow,background-color,border-color] duration-200 ${batchMode ? selectedSessionIds.includes(session.id) ? 'border border-red-400 bg-red-900/15' : 'bg-bg-2' : activeSessionId === session.id ? 'border border-accent bg-accent/20' : 'bg-bg-2'} ${isOverlay ? 'border border-accent bg-bg-1 shadow-[0_20px_48px_rgba(0,0,0,0.42)]' : ''}`}>
                    {batchMode && <button onClick={() => toggleBatchSession(session.id)} className={`flex h-9 w-7 shrink-0 items-center justify-center rounded text-sm leading-none ${selectedSessionIds.includes(session.id) ? 'text-red-300' : 'text-text-3'} active:bg-bg-1`}>{selectedSessionIds.includes(session.id) ? '☑' : '☐'}</button>}
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
                      <button onClick={() => void handleRenameSession(session.id)} className="rounded px-2 py-2 text-xs text-text-2 active:bg-bg-1" aria-label={t('sidebar.renameSession')} title={t('sidebar.renameSession')}>✎</button>
                      <button onClick={() => setPendingDeleteSessionId(session.id)} className="rounded px-2 py-2 text-sm text-text-2 active:bg-bg-1" aria-label={t('sidebar.deleteSession')} title={t('sidebar.deleteSession')}>×</button>
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
              {sessionWindows.length === 0 ? (
                <div className="text-center text-text-3 py-4">{t('drawer.noWindows')}</div>
              ) : (
                sessionWindows.map((window: any) => (
                  <button
                    key={window.id}
                    onClick={() => void handleSelectWindow(window.id)}
                    className={`w-full rounded-lg p-3 text-left transition-colors ${window.active ? 'border border-accent bg-accent/20' : 'bg-bg-2 active:bg-bg-1'}`}
                  >
                    <div className="truncate text-text-1">{window.name}</div>
                    <div className="text-text-3 text-xs">#{window.index + 1}</div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      {showTemplates && <ModalPortal><SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} /></ModalPortal>}
      <ConfirmDialog open={!!pendingDeleteSessionId} title={t('sidebar.deleteTitle')} message={t('sidebar.deleteConfirm', { name: sessions.find((item: any) => item.id === pendingDeleteSessionId)?.name || '' })} confirmLabel={t('sidebar.confirmDelete')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDeleteSessionId(null)} onConfirm={() => void confirmDeleteSession()} />
      <ConfirmDialog open={batchDeleteConfirmOpen} title={t('sidebar.batchDeleteTitle')} message={t('sidebar.batchDeleteConfirm', { count: selectedSessionIds.length })} confirmLabel={t('sidebar.batchDeleteSelected')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setBatchDeleteConfirmOpen(false)} onConfirm={() => void confirmBatchDeleteSession()} />
      {PromptElement}
    </div>
  )
}
