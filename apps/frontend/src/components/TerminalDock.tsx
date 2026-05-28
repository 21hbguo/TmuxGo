'use client'
import { useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { WindowTabs } from './WindowTabs'
import { PaneGrid } from './PaneGrid'

export function TerminalDock({ fill=false }:{ fill?: boolean }) {
  const terminalPanelHeight = useConsoleStore((state) => state.terminalPanelHeight)
  const setTerminalPanelHeight = useConsoleStore((state) => state.setTerminalPanelHeight)
  const resizingRef = useRef(false)
  useEffect(() => {
    if (fill) return
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return
      setTerminalPanelHeight(window.innerHeight - event.clientY - 28)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'terminal-panel-resize', height: window.innerHeight - event.clientY - 28 } }))
    }
    const handleUp = () => {
      resizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'terminal-panel-resize-end' } }))
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [fill, setTerminalPanelHeight])
  return (
    <section className={`relative bg-bg-1 ${fill ? 'flex h-full min-h-0 flex-1 flex-col' : 'shrink-0 border-t border-[var(--line)]'}`} style={fill ? undefined : { height: terminalPanelHeight }}>
      {!fill && <div className="absolute left-0 right-0 top-0 z-10 h-1 cursor-row-resize hover:bg-accent/50" onMouseDown={() => {
        resizingRef.current = true
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
      }} />}
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-3">Terminal</div>
          <div className="text-[11px] text-text-3">{fill ? 'Full' : `${terminalPanelHeight}px`}</div>
        </div>
        <WindowTabs />
        <div className="min-h-0 flex-1">
          <PaneGrid />
        </div>
      </div>
    </section>
  )
}
