'use client'
import { useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { WindowTabs } from './WindowTabs'
import { PaneGrid } from './PaneGrid'
import { useTranslation } from '@/i18n'

function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
export function TerminalDock({ fill=false,minHeight=180,maxHeight=540,dragViewportHeight }:{ fill?: boolean; minHeight?: number; maxHeight?: number; dragViewportHeight?: number }) {
  const terminalPanelHeight = useConsoleStore((state) => state.terminalPanelHeight)
  const setTerminalPanelHeight = useConsoleStore((state) => state.setTerminalPanelHeight)
  const { t } = useTranslation()
  const panelRef = useRef<HTMLElement>(null)
  const resizingRef = useRef(false)
  const pendingHeightRef = useRef(terminalPanelHeight)
  const frameRef = useRef<number | null>(null)
  const [previewHeight,setPreviewHeight] = useState<number | null>(null)
  const getResizeHeight = (clientY: number) => {
    const bottom = panelRef.current?.getBoundingClientRect().bottom
    if (bottom && Number.isFinite(bottom)) return clampValue(bottom-clientY,minHeight,maxHeight)
    return clampValue((dragViewportHeight || window.innerHeight)-clientY-28,minHeight,maxHeight)
  }
  useEffect(() => {
    if (fill) return
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return
      pendingHeightRef.current = getResizeHeight(event.clientY)
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setPreviewHeight(pendingHeightRef.current)
      })
    }
    const handleUp = () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (resizingRef.current) {
        setTerminalPanelHeight(pendingHeightRef.current)
        setPreviewHeight(null)
        window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'terminal-panel-resize-end', height: pendingHeightRef.current } }))
      }
      resizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dragViewportHeight, fill, maxHeight, minHeight, setTerminalPanelHeight])
  const panelHeight = fill ? terminalPanelHeight : clampValue(previewHeight ?? terminalPanelHeight, minHeight, maxHeight)
  useEffect(() => {
    if (fill) return
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'terminal-panel-resize', height: panelHeight } }))
  }, [fill, panelHeight])
  const handleMouseDown = () => {
    resizingRef.current = true
    pendingHeightRef.current = terminalPanelHeight
    setPreviewHeight(terminalPanelHeight)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }
  const handleDoubleClick = () => {
    if (fill) return
    setTerminalPanelHeight(maxHeight)
  }
  return (
    <section ref={panelRef} className={`tmuxgo-content-surface ${fill ? 'relative flex h-full min-h-0 flex-1 flex-col' : 'relative shrink-0 border-t border-[var(--line)]'}`} style={fill ? undefined : { height: panelHeight }}>
      {!fill && <div className="absolute left-0 right-0 top-0 z-10 h-1 cursor-row-resize hover:bg-accent/50" onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick} />}
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-3">{t('dock.terminal')}</div>
          <div className="text-[11px] text-text-3">{fill ? t('dock.full') : `${panelHeight}px`}</div>
        </div>
        <WindowTabs />
        <div className="min-h-0 flex-1">
          <PaneGrid />
        </div>
      </div>
    </section>
  )
}
