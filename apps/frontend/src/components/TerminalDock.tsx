'use client'
import { useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { TerminalDockPosition } from '@/stores/useConsoleStore'
import { WindowTabs } from './WindowTabs'
import { PaneGrid } from './PaneGrid'

function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
export function TerminalDock({
  fill = false,
  dock = 'bottom',
  minHeight = 180,
  maxHeight = 540,
  dragViewportHeight,
  minWidth = 300,
  maxWidth = 960,
  dragViewportWidth,
}: {
  fill?: boolean
  dock?: TerminalDockPosition
  minHeight?: number
  maxHeight?: number
  dragViewportHeight?: number
  minWidth?: number
  maxWidth?: number
  dragViewportWidth?: number
}) {
  const side = dock === 'left' || dock === 'right'
  const terminalPanelHeight = useConsoleStore((state) => state.terminalPanelHeight)
  const setTerminalPanelHeight = useConsoleStore((state) => state.setTerminalPanelHeight)
  const terminalPanelWidth = useConsoleStore((state) => state.terminalPanelWidth)
  const setTerminalPanelWidth = useConsoleStore((state) => state.setTerminalPanelWidth)
  const panelRef = useRef<HTMLElement>(null)
  const resizingRef = useRef(false)
  const pendingSizeRef = useRef(terminalPanelHeight)
  const frameRef = useRef<number | null>(null)
  const [previewSize, setPreviewSize] = useState<number | null>(null)
  const getResizeSize = (event: MouseEvent) => {
    const rect = panelRef.current?.getBoundingClientRect()
    if (side) {
      // 右侧停靠时手柄在面板左缘，宽度 = 面板右边 - 鼠标 X；左侧停靠镜像
      if (rect)
        return clampValue(dock === 'right' ? rect.right - event.clientX : event.clientX - rect.left, minWidth, maxWidth)
      const viewport = dragViewportWidth || window.innerWidth
      return clampValue(dock === 'right' ? viewport - event.clientX : event.clientX, minWidth, maxWidth)
    }
    const bottom = rect?.bottom
    if (bottom && Number.isFinite(bottom)) return clampValue(bottom - event.clientY, minHeight, maxHeight)
    return clampValue((dragViewportHeight || window.innerHeight) - event.clientY - 28, minHeight, maxHeight)
  }
  useEffect(() => {
    if (fill) return
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return
      pendingSizeRef.current = getResizeSize(event)
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setPreviewSize(pendingSizeRef.current)
      })
    }
    const handleUp = () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (resizingRef.current) {
        if (side) setTerminalPanelWidth(pendingSizeRef.current)
        else setTerminalPanelHeight(pendingSizeRef.current)
        setPreviewSize(null)
        window.dispatchEvent(
          new CustomEvent('tmuxgo-layout-change', {
            detail: { reason: 'terminal-panel-resize-end', size: pendingSizeRef.current },
          }),
        )
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
  })
  // dock 变化后通知终端 refit
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'terminal-dock-change', dock } }))
  }, [dock])
  const baseSize = side ? terminalPanelWidth : terminalPanelHeight
  const panelSize = fill
    ? baseSize
    : clampValue(previewSize ?? baseSize, side ? minWidth : minHeight, side ? maxWidth : maxHeight)
  const handleMouseDown = () => {
    resizingRef.current = true
    pendingSizeRef.current = baseSize
    setPreviewSize(baseSize)
    document.body.style.cursor = side ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }
  const handleDoubleClick = () => {
    if (fill) return
    if (side) setTerminalPanelWidth(maxWidth)
    else setTerminalPanelHeight(maxHeight)
  }
  const resizeHandleClass = side
    ? `absolute top-0 bottom-0 z-10 w-1 cursor-col-resize hover:bg-accent/50 ${dock === 'right' ? 'left-0' : 'right-0'}`
    : 'absolute left-0 right-0 top-0 z-10 h-1 cursor-row-resize hover:bg-accent/50'
  return (
    // order 0/1 配合外层 flex 方向控制停靠侧，保持 JSX 位置不变避免 xterm 重挂载
    <section
      ref={panelRef}
      className={`tmuxgo-content-surface ${fill ? 'relative flex h-full min-h-0 flex-1 flex-col' : `relative shrink-0 ${side ? (dock === 'right' ? 'border-l' : 'border-r') : 'border-t'} border-[var(--line)]`}`}
      style={
        fill ? undefined : side ? { width: panelSize, order: dock === 'left' ? 0 : 1 } : { height: panelSize, order: 1 }
      }
    >
      {!fill && <div className={resizeHandleClass} onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick} />}
      <div className="flex h-full min-h-0 flex-col">
        <WindowTabs />
        <div className="min-h-0 flex-1">
          <PaneGrid />
        </div>
      </div>
    </section>
  )
}
