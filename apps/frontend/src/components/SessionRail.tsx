'use client'
import { useEffect, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession, useDeleteSession, useRenameSession } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { SessionTemplates, type Template } from './SessionTemplates'
import { ConfirmDialog } from './ConfirmDialog'
import { useTranslation } from '@/i18n'
import { usePrompt } from '@/hooks/usePrompt'
import { SessionSortableList } from './SessionSortableList'
import { FiChevronRight, FiEdit2, FiPlus, FiTrash2 } from 'react-icons/fi'

export function SessionRail() {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const setSessionPanelExpanded = useConsoleStore((state) => state.setSessionPanelExpanded)
  const { data: sessions = [], moveSession, isError, refetch } = useOrderedSessions(activeHostId || '')
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const renameSession = useRenameSession()
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const [showTemplates, setShowTemplates] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const handleTemplateSelect = async (template: Template) => {
    if (!activeHostId) return
    const name = await prompt(t('drawer.sessionName'), template.name.toLowerCase())
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
  const confirmDeleteSession = async () => {
    if (!activeHostId || !pendingDeleteSessionId) return
    const session = sessions.find((item) => item.id === pendingDeleteSessionId)
    try {
      await deleteSession.mutateAsync({ hostId: activeHostId, sessionId: pendingDeleteSessionId })
      if (activeSessionId === pendingDeleteSessionId) {
        const next = sessions.find((item) => item.id !== pendingDeleteSessionId)?.id || ''
        setActiveSession(next)
      }
      pushToast({ type: 'success', message: t('session.deleted', { name: session?.name || pendingDeleteSessionId }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setPendingDeleteSessionId(null)
  }
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [contextMenu])
  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])
  return (
    <>
      <aside className="tmuxgo-material flex h-full w-[clamp(61px,9vw,109px)] shrink-0 flex-col border-r">
        <button onClick={() => setSessionPanelExpanded(true)} className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 text-left text-xs font-semibold text-text-3 hover:bg-bg-2/55 hover:text-text-1"><FiChevronRight aria-hidden="true" className="shrink-0" /><span className="min-w-0 truncate">{t('sidebar.sessions')}</span></button>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 scrollbar-none">
          {isError ? <button onClick={() => void refetch()} title={t('session.loadFailed')} className="flex h-10 w-full items-center justify-center rounded-lg bg-red-900/20 text-xs text-danger">{t('common.retry')}</button> : <SessionSortableList
            sessions={sessions}
            onMove={moveSession}
            listClassName="flex min-h-full flex-col gap-2"
            getItemClassName={({ session, isDragging, isOverlay }) => {
              const active = session.id === activeSessionId
              return `rounded-lg ${isOverlay ? 'shadow-[0_18px_44px_rgba(0,0,0,0.42)]' : ''} ${isDragging && !isOverlay ? 'opacity-40' : ''}`
            }}
            renderItem={({ session, isOverlay }) => {
              const active = session.id === activeSessionId
              return (
                <button title={session.name} onClick={() => setActiveSession(session.id)} onDoubleClick={() => void handleRenameSession(session.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id }) }} className={`flex h-11 min-w-0 w-full items-center gap-2 rounded-lg border px-2 text-left transition-[transform,box-shadow,background-color,border-color,color] duration-200 ${active ? 'border-[var(--line)] bg-bg-2 text-accent' : 'border-transparent bg-transparent text-text-3 hover:bg-bg-2 hover:text-text-1'} ${isOverlay ? 'border-accent bg-bg-1 text-text-1 shadow-[0_18px_44px_rgba(0,0,0,0.42)]' : ''}`}>
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ${active ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2'}`}>{session.name.slice(0, 2).toUpperCase()}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-text-1">{session.name}</span>
                      <span className="block truncate text-[10px] text-text-3">{t('sidebar.windows', { count: session.windowCount })}</span>
                    </span>
                  </span>
                </button>
              )
            }}
          />}
        </div>
        <div className="shrink-0 border-t border-[var(--line)] p-2">
          <button aria-label={t('sidebar.newSession')} title={t('sidebar.newSession')} onClick={() => setShowTemplates(true)} className="tmuxgo-icon-button tmuxgo-glass-control flex h-10 w-full items-center justify-center rounded-lg text-sm text-accent hover:text-text-1"><FiPlus aria-hidden="true" size={17} /></button>
        </div>
      </aside>
      {showTemplates && <SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} />}
      {contextMenu && (
        <div className="fixed z-[90] w-40 overflow-hidden rounded-lg border border-[var(--line)] bg-bg-1 py-1 text-xs shadow-lg" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setSessionPanelExpanded(true); setContextMenu(null) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-2 hover:bg-bg-2 hover:text-text-1">
            <FiChevronRight aria-hidden="true" size={13} />{t('sidebar.sessions')}
          </button>
          <button onClick={() => { void handleRenameSession(contextMenu.sessionId); setContextMenu(null) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-2 hover:bg-bg-2 hover:text-text-1">
            <FiEdit2 aria-hidden="true" size={13} />{t('sidebar.renameSession')}
          </button>
          <button onClick={() => { setPendingDeleteSessionId(contextMenu.sessionId); setContextMenu(null) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-red-900/20">
            <FiTrash2 aria-hidden="true" size={13} />{t('sidebar.deleteSession')}
          </button>
        </div>
      )}
      <ConfirmDialog open={!!pendingDeleteSessionId} title={t('sidebar.deleteTitle')} message={t('sidebar.deleteConfirm', { name: sessions.find((item) => item.id === pendingDeleteSessionId)?.name || '' })} confirmLabel={t('sidebar.confirmDelete')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDeleteSessionId(null)} onConfirm={() => void confirmDeleteSession()} />
      {PromptElement}
    </>
  )
}
