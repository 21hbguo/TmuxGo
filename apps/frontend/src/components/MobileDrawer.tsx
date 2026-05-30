'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useCreateSession, useDeleteSession, useRenameSession, useSessions } from '@/hooks/useApi'
import { SessionTemplates, type Template } from './SessionTemplates'
import { useTranslation } from '@/i18n'
import { QuickActions } from './QuickActions'
import { ConfirmDialog } from './ConfirmDialog'

interface MobileDrawerProps {
  isOpen: boolean
  onClose: () => void
  type: 'sessions' | 'panes'
}

export function MobileDrawer({ isOpen, onClose, type }: MobileDrawerProps) {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const createSession = useCreateSession()
  const renameSession = useRenameSession()
  const deleteSession = useDeleteSession()
  const { t } = useTranslation()
  const [showTemplates, setShowTemplates] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)

  const handleTemplateSelect = async (template: Template) => {
    if (!activeHostId) return
    const name = prompt(t('drawer.sessionName'), template.name.toLowerCase())
    if (!name) return
    try {
      const created = await createSession.mutateAsync({ hostId: activeHostId, name, layout: template.layout })
      if (created?.id) setActiveSession(created.id)
      pushToast({ type: 'success', message: `Session ${name} created` })
      onClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
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
    const name = window.prompt(t('drawer.renamePrompt'), session?.name || '')
    if (!name || name === session?.name) return
    try {
      const renamed = await renameSession.mutateAsync({ hostId: activeHostId, sessionId, name })
      if (activeSessionId === sessionId && renamed?.id) setActiveSession(renamed.id)
      pushToast({ type: 'success', message: `Session ${session?.name || sessionId} renamed to ${name}` })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
    }
  }
  const confirmDeleteSession = async () => {
    if (!activeHostId || !pendingDeleteSessionId) return
    const session = sessions.find((item: any) => item.id === pendingDeleteSessionId)
    try {
      await deleteSession.mutateAsync({ hostId: activeHostId, sessionId: pendingDeleteSessionId })
      if (activeSessionId === pendingDeleteSessionId) setActiveSession(sessions.find((item: any) => item.id !== pendingDeleteSessionId)?.id || '')
      pushToast({ type: 'success', message: `Session ${session?.name || pendingDeleteSessionId} deleted` })
      onClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Request failed' })
    }
    setPendingDeleteSessionId(null)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={handleClose}
      />
      <div
        ref={panelRef}
        className={`absolute bottom-0 left-0 right-0 flex max-h-none flex-col overflow-hidden rounded-t-xl border-t border-[var(--line)] bg-bg-1 transition-transform duration-200 ease-out ${closing ? 'translate-y-full' : ''}`}
        style={{ maxHeight: 'calc(var(--app-height,100dvh)-12px)', paddingBottom: 'env(safe-area-inset-bottom,0px)' }}
      >
        <div className="flex justify-center py-2 touch-none" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchEnd}>
          <div className="w-10 h-1 rounded-full bg-text-3/30" />
        </div>
        <div className="flex items-center justify-between px-4 pb-3">
          <h3 className="text-text-1 font-medium">
            {type === 'sessions' ? t('drawer.sessions') : t('drawer.panes')}
          </h3>
          <button onClick={handleClose} className="p-1 text-text-3">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" style={{ WebkitOverflowScrolling: 'touch' }}>
          {type === 'sessions' && (
            <div className="space-y-2">
              <button
                onClick={() => setShowTemplates(true)}
                className="w-full rounded-lg p-3 text-left border border-dashed border-[var(--line)] text-accent active:bg-accent/10 transition-colors"
              >
                + {t('sidebar.newSession')}
              </button>
              {sessions.map((session: any) => (
                <div key={session.id} className={`flex items-center gap-2 rounded-lg p-2 transition-transform active:scale-[0.98] ${activeSessionId === session.id ? 'border border-accent bg-accent/20' : 'bg-bg-2'}`}>
                  <button
                    onClick={() => {
                      setActiveSession(session.id)
                      handleClose()
                    }}
                    className="min-w-0 flex-1 px-1 py-1 text-left"
                  >
                    <div className="truncate text-text-1">{session.name}</div>
                    <div className="text-text-3 text-xs">{t('drawer.windows', { count: session.windowCount })}</div>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => void handleRenameSession(session.id)} className="rounded px-2 py-2 text-xs text-text-2 active:bg-bg-1" aria-label={t('sidebar.renameSession')} title={t('sidebar.renameSession')}>✎</button>
                    <button onClick={() => setPendingDeleteSessionId(session.id)} className="rounded px-2 py-2 text-sm text-text-2 active:bg-bg-1" aria-label={t('sidebar.deleteSession')} title={t('sidebar.deleteSession')}>×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {type === 'panes' && (
            <QuickActions />
          )}
        </div>
      </div>
      {showTemplates && <SessionTemplates onSelect={handleTemplateSelect} onClose={() => setShowTemplates(false)} />}
      <ConfirmDialog open={!!pendingDeleteSessionId} title={t('sidebar.deleteTitle')} message={t('sidebar.deleteConfirm', { name: sessions.find((item: any) => item.id === pendingDeleteSessionId)?.name || '' })} confirmLabel={t('sidebar.confirmDelete')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDeleteSessionId(null)} onConfirm={() => void confirmDeleteSession()} />
    </div>
  )
}
