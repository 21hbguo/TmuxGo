'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionThumbnails } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useSplitGroups } from '@/hooks/useSplitGroups'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import type { SessionThumbnailPane } from '@/types'
import { PaneGrid } from './PaneGrid'

const LONG_PRESS_MS = 500
const DRAG_THRESHOLD = 8
type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

function paneStyle(pane: SessionThumbnailPane, width: number, height: number) {
  return {
    left: `${(pane.left / width) * 100}%`,
    top: `${(pane.top / height) * 100}%`,
    width: `${(pane.size.cols / width) * 100}%`,
    height: `${(pane.size.rows / height) * 100}%`,
  }
}

export function SessionThumbnailPanel() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setThumbnailPanelOpen = useConsoleStore((state) => state.setThumbnailPanelOpen)
  const openSplitGroup = useConsoleStore((state) => state.openSplitGroup)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data: orderedSessions = [] } = useOrderedSessions(activeHostId || '')
  const { data, isLoading, isFetching, isError, refetch } = useSessionThumbnails(activeHostId || '')
  const { groups, create, update, remove } = useSplitGroups()
  const { t } = useTranslation()
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [recentOrder, setRecentOrder] = useState<string[]>([])
  const thumbnails = useMemo(() => {
    const thumbnailById = new Map((data?.sessions || []).map((item) => [item.id, item]))
    return orderedSessions.map((session) => thumbnailById.get(session.id)).filter((item): item is NonNullable<typeof item> => !!item)
  }, [data?.sessions, orderedSessions])
  const bumpRecent = useCallback((sessionId: string) => {
    if (!sessionId) return
    setRecentOrder((prev) => [sessionId, ...prev.filter((id) => id !== sessionId)].slice(0, 24))
  }, [])
  useEffect(() => { bumpRecent(activeSessionId || '') }, [activeSessionId, bumpRecent])
  const orderedThumbnails = useMemo(() => {
    const rank = new Map(recentOrder.map((id, index) => [id, index]))
    return [...thumbnails].sort((a, b) => {
      const rankA = rank.get(a.id)
      const rankB = rank.get(b.id)
      if (rankA == null && rankB == null) return 0
      if (rankA == null) return 1
      if (rankB == null) return -1
      return rankA - rankB
    })
  }, [recentOrder, thumbnails])
  const selectedThumbnail = orderedThumbnails.find((item) => item.id === selectedSessionId) || null
  useEffect(() => {
    setSelectedSessionId((current) => thumbnails.some((item) => item.id === current) ? current : thumbnails.find((item) => item.id === activeSessionId)?.id || thumbnails[0]?.id || '')
  }, [activeSessionId, thumbnails])
  const dragStateRef = useRef<{ pointerId: number; x: number; y: number; sessionId: string; longPress: boolean; moved: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null)
  const dropHintRef = useRef<{ sessionId: string; zone: DropZone } | null>(null)
  const suppressClickRef = useRef(false)
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; sessionId: string } | null>(null)
  const [dropHint, setDropHint] = useState<{ sessionId: string; zone: DropZone } | null>(null)
  const sessionNameOf = useCallback((sessionId: string) => thumbnails.find((item) => item.id === sessionId)?.name || sessionId, [thumbnails])
  const handleCardPointerDown = useCallback((e: React.PointerEvent, sessionId: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    dragStateRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, sessionId, longPress: false, moved: false, timer: null }
    dragStateRef.current.timer = setTimeout(() => {
      const state = dragStateRef.current
      if (!state || state.moved || state.longPress || state.pointerId !== e.pointerId) return
      state.longPress = true
      setDragPreview({ x: state.x, y: state.y, sessionId: state.sessionId })
    }, LONG_PRESS_MS)
  }, [])
  const handleCardPointerMove = useCallback((e: React.PointerEvent) => {
    const state = dragStateRef.current
    if (!state || state.pointerId !== e.pointerId) return
    if (!state.longPress) {
      if (Math.abs(e.clientX - state.x) > DRAG_THRESHOLD || Math.abs(e.clientY - state.y) > DRAG_THRESHOLD) {
        state.moved = true
        if (state.timer) {
          clearTimeout(state.timer)
          state.timer = null
        }
      }
      return
    }
    state.x = e.clientX
    state.y = e.clientY
    setDragPreview({ x: e.clientX, y: e.clientY, sessionId: state.sessionId })
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const card = el?.closest?.('[data-split-session-id]') as HTMLElement | null
    if (card) {
      const targetId = card.getAttribute('data-split-session-id') || ''
      const rect = card.getBoundingClientRect()
      const dx = e.clientX - (rect.left + rect.width / 2)
      const dy = e.clientY - (rect.top + rect.height / 2)
      const zone: DropZone = Math.abs(dx) < rect.width * 0.2 && Math.abs(dy) < rect.height * 0.2 ? 'center' : Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom')
      const hint = { sessionId: targetId, zone }
      dropHintRef.current = hint
      setDropHint(hint)
    } else {
      dropHintRef.current = null
      setDropHint(null)
    }
  }, [])
  const finishDrag = useCallback(() => {
    const state = dragStateRef.current
    dragStateRef.current = null
    if (state?.timer) clearTimeout(state.timer)
    setDragPreview(null)
    const hint = dropHintRef.current
    dropHintRef.current = null
    setDropHint(null)
    if (!state || !state.longPress || !hint || hint.sessionId === state.sessionId) return
    suppressClickRef.current = true
    const direction = hint.zone === 'top' || hint.zone === 'bottom' ? 'vertical' : 'horizontal'
    const hostId = activeHostId || 'local'
    const existing = groups.find((item) => item.primarySessionId === state.sessionId || item.secondarySessionId === state.sessionId)
    if (existing) update(existing.id, { primarySessionId: state.sessionId, secondarySessionId: hint.sessionId, direction })
    else create({ hostId, primarySessionId: state.sessionId, secondarySessionId: hint.sessionId, direction })
    pushToast({ type: 'success', message: t('split.created', { primary: sessionNameOf(state.sessionId), secondary: sessionNameOf(hint.sessionId) }) })
  }, [activeHostId, create, groups, pushToast, sessionNameOf, t, update])
  const handleCardPointerUp = useCallback((e: React.PointerEvent) => {
    const state = dragStateRef.current
    if (!state || state.pointerId !== e.pointerId) return
    finishDrag()
  }, [finishDrag])
  const handleCardPointerCancel = useCallback((e: React.PointerEvent) => {
    const state = dragStateRef.current
    if (!state || state.pointerId !== e.pointerId) return
    dragStateRef.current = null
    if (state.timer) clearTimeout(state.timer)
    setDragPreview(null)
    dropHintRef.current = null
    setDropHint(null)
  }, [])
  const handleCardClick = useCallback((sessionId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    bumpRecent(sessionId)
    setSelectedSessionId(sessionId)
  }, [bumpRecent])
  const dropZoneClass: Record<DropZone, string> = {
    left: 'absolute left-0 top-0 z-20 h-full w-1/2 bg-accent/30',
    right: 'absolute right-0 top-0 z-20 h-full w-1/2 bg-accent/30',
    top: 'absolute left-0 top-0 z-20 h-1/2 w-full bg-accent/30',
    bottom: 'absolute bottom-0 left-0 z-20 h-1/2 w-full bg-accent/30',
    center: 'absolute inset-0 z-20 border-2 border-accent bg-accent/20',
  }
  return <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
      <div className="min-w-0 flex-1 text-sm font-semibold text-text-1">{t('thumbnail.title')}</div>
      <Button title={t('thumbnail.refresh')} aria-label="refresh" className={isFetching ? 'text-accent' : ''} onClick={() => void refetch()}>↻</Button>
      <Button title={t('thumbnail.close')} aria-label="close" onClick={() => setThumbnailPanelOpen(false)}>×</Button>
    </div>
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
      {groups.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 px-1 text-caption text-text-3">{t('split.title')}</div>
          <div className="space-y-1">
            {groups.map((group) => {
              const primaryName = sessionNameOf(group.primarySessionId)
              const secondaryName = sessionNameOf(group.secondarySessionId)
              return (
                <div key={group.id} className="flex items-center gap-1 rounded-apple border border-[var(--line)] bg-bg-0 px-2 py-1">
                  <button title={t('split.open')} onClick={() => openSplitGroup(group.id)} className="min-w-0 flex-1 truncate text-left font-mono text-xs text-text-1 hover:text-accent">
                    <span className="text-accent">{primaryName}</span> {group.direction === 'horizontal' ? '⇄' : '⇅'} <span className="text-text-2">{secondaryName}</span>
                  </button>
                  <span className="shrink-0 text-caption text-text-3">{Math.round(group.primaryRatio * 100)}%</span>
                  <button aria-label={t('split.delete')} title={t('split.delete')} onClick={() => remove(group.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-danger/15 hover:text-danger">×</button>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {isLoading && <div className="p-2 text-xs text-text-3">{t('thumbnail.loading')}</div>}
      {isError && <div className="p-2 text-xs text-text-3">{t('thumbnail.unavailable')}</div>}
      {!isLoading && !isError && !thumbnails.length && <div className="p-2 text-xs text-text-3">{t('thumbnail.empty')}</div>}
      {!!selectedThumbnail && <div className="relative mb-2 overflow-hidden rounded-apple border border-accent bg-bg-0" data-testid="thumbnail-selected-card" data-split-session-id={selectedThumbnail.id}>
        <div className="flex h-8 items-center gap-2 border-b border-[var(--line)] px-3">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-1">{selectedThumbnail.name}</span>
          <span className="shrink-0 text-caption text-text-3">{selectedThumbnail.window?.name}</span>
        </div>
        <div className="relative h-[54vh] min-h-[320px] max-h-[680px]"><PaneGrid key={selectedThumbnail.id} sessionId={selectedThumbnail.id} />{dropHint?.sessionId === selectedThumbnail.id && dropHint && <div className={dropZoneClass[dropHint.zone]} />}</div>
      </div>}
      <div className="grid grid-cols-1 gap-2 min-[720px]:grid-cols-2">
        {orderedThumbnails.filter((thumbnail) => thumbnail.id !== selectedSessionId).map((thumbnail) => {
          const width = Math.max(1, ...thumbnail.panes.map((pane) => pane.left + pane.size.cols))
          const height = Math.max(1, ...thumbnail.panes.map((pane) => pane.top + pane.size.rows))
          const isDropTarget = dropHint?.sessionId === thumbnail.id
          return <button key={thumbnail.id} data-split-session-id={thumbnail.id} title={thumbnail.name} onClick={() => handleCardClick(thumbnail.id)} onPointerDown={(e) => handleCardPointerDown(e, thumbnail.id)} onPointerMove={handleCardPointerMove} onPointerUp={handleCardPointerUp} onPointerCancel={handleCardPointerCancel} className={`group relative h-48 touch-none overflow-hidden rounded-apple border bg-bg-0 text-left transition-colors hover:border-accent hover:bg-bg-2 ${isDropTarget ? 'border-accent' : 'border-[var(--line)]'}`}>
            <div className="flex h-7 items-center gap-2 border-b border-[var(--line)] px-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-3/50 group-hover:bg-accent" />
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-text-2 group-hover:text-text-1">{thumbnail.name}</span>
              <span className="shrink-0 text-caption text-text-3">{thumbnail.window?.name}</span>
            </div>
            <div className="relative h-[calc(100%-1.75rem)] overflow-hidden bg-[#080b0f]">
              {thumbnail.panes.map((pane) => <div key={pane.id} className={`absolute overflow-hidden border border-white/10 ${pane.active ? 'border-accent/50' : ''}`} style={paneStyle(pane, width, height)}>
                <pre className="m-0 min-h-full whitespace-pre p-1 font-mono text-[4px] leading-[6px] text-[#a8b6c7]">{pane.data || ' '}</pre>
              </div>)}
              {isDropTarget && dropHint && <div className={dropZoneClass[dropHint.zone]} />}
            </div>
          </button>
        })}
      </div>
      {dragPreview && (
        <div className="pointer-events-none fixed z-[100] rounded-apple border border-accent bg-bg-2 px-3 py-2 text-xs text-text-1 shadow-lg" style={{ left: dragPreview.x, top: dragPreview.y, transform: 'translate(-50%, -120%)' }}>
          {sessionNameOf(dragPreview.sessionId)}
        </div>
      )}
    </div>
  </section>
}
