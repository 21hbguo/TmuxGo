'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useSplitGroups, type SessionSplitGroup } from '@/hooks/useSplitGroups'
import { useSessionSocket } from '@/hooks/useSessionSocket'
import { useSessions } from '@/hooks/useApi'
import { PaneGrid } from './PaneGrid'
import { ShortcutBar } from './ShortcutBar'
import { useTranslation } from '@/i18n'
import { FiRepeat, FiX } from 'react-icons/fi'

export function SessionSplitView({ group }: { group: SessionSplitGroup }) {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const toggleFilePanel = useConsoleStore((s) => s.toggleFilePanel)
  const closeSplitGroup = useConsoleStore((s) => s.closeSplitGroup)
  const { update } = useSplitGroups()
  const { data: sessions = [] } = useSessions(activeHostId || '')
  const { t } = useTranslation()
  const hostId = activeHostId || 'local'
  const primarySocket = useSessionSocket(hostId, group.primarySessionId)
  const secondarySocket = useSessionSocket(hostId, group.secondarySessionId)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const previewRatioRef = useRef<number | null>(null)
  const [previewRatio, setPreviewRatio] = useState<number | null>(null)
  const ratio = previewRatio ?? group.primaryRatio
  const horizontal = group.direction === 'horizontal'
  const primaryName = sessions.find((item: any) => item.id === group.primarySessionId)?.name || group.primarySessionId
  const secondaryName = sessions.find((item: any) => item.id === group.secondarySessionId)?.name || group.secondarySessionId
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    previewRatioRef.current = null
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [horizontal])
  useEffect(() => {
    if (!draggingRef.current) return
    const handleMove = (e: PointerEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const raw = horizontal ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height
      const next = Math.min(0.8, Math.max(0.5, raw))
      previewRatioRef.current = next
      setPreviewRatio(next)
    }
    const handleUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const finalRatio = previewRatioRef.current
      previewRatioRef.current = null
      setPreviewRatio(null)
      if (finalRatio !== null) update(group.id, { primaryRatio: finalRatio })
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [group.id, horizontal, update])
  const swap = useCallback(() => {
    update(group.id, { primarySessionId: group.secondarySessionId, secondarySessionId: group.primarySessionId })
  }, [group.id, group.primarySessionId, group.secondarySessionId, update])
  const primarySize = horizontal ? { width: `${ratio * 100}%` } : { height: `${ratio * 100}%` }
  const secondarySize = horizontal ? { flex: 1 } : { flex: 1 }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
      <div className="shrink-0 border-b border-[var(--line)] bg-bg-1">
        <ShortcutBar mode="dock" onOpenFiles={toggleFilePanel} />
      </div>
      <div ref={containerRef} className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${horizontal ? 'flex-row' : 'flex-col'}`}>
        <div className="relative min-h-0 min-w-0 overflow-hidden" style={primarySize}>
          <div className="absolute left-0 top-0 z-10 flex h-7 max-w-full items-center gap-2 border-b border-r border-[var(--line)] bg-bg-1/85 px-2 backdrop-blur">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-text-1">{primaryName}</span>
            <span className="shrink-0 text-caption text-text-3">{t('split.primary')}</span>
          </div>
          <PaneGrid key={group.primarySessionId} sessionId={group.primarySessionId} socket={primarySocket} shared />
        </div>
        <div onPointerDown={handlePointerDown} className={`z-20 shrink-0 bg-[var(--line)] transition-colors hover:bg-accent ${horizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`} />
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" style={secondarySize}>
          <div className="absolute left-0 top-0 z-10 flex h-7 max-w-full items-center gap-2 border-b border-r border-[var(--line)] bg-bg-1/85 px-2 backdrop-blur">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-3/60" />
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-text-2">{secondaryName}</span>
            <span className="shrink-0 text-caption text-text-3">{t('split.secondary')}</span>
            <button aria-label={t('split.swap')} title={t('split.swap')} onClick={swap} className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm text-text-3 hover:text-accent"><FiRepeat aria-hidden="true" size={13} /></button>
            <button aria-label={t('split.close')} title={t('split.close')} onClick={closeSplitGroup} className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm text-text-3 hover:text-danger"><FiX aria-hidden="true" size={13} /></button>
          </div>
          <PaneGrid key={group.secondarySessionId} sessionId={group.secondarySessionId} socket={secondarySocket} shared />
        </div>
      </div>
    </div>
  )
}
