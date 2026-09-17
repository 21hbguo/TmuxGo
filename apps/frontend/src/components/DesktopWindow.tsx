'use client'
import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

export type DesktopWindowRect = { x: number; y: number; w: number; h: number }
type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 420
const MIN_H = 260
const STORAGE_KEY = 'tmuxgo-desktop-window-rect'

function clampRect(rect: DesktopWindowRect): DesktopWindowRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(Math.max(rect.w, MIN_W), Math.max(MIN_W, vw - 8))
  const h = Math.min(Math.max(rect.h, MIN_H), Math.max(MIN_H, vh - 8))
  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, 0), Math.max(0, vw - w)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, vh - h)),
  }
}

function defaultRect(): DesktopWindowRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.round(Math.min(vw * 0.72, 1280))
  const h = Math.round(Math.min(vh * 0.78, 860))
  return clampRect({ x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h })
}

function readRect(): DesktopWindowRect {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DesktopWindowRect>
      if (
        Number.isFinite(parsed.x) &&
        Number.isFinite(parsed.y) &&
        Number.isFinite(parsed.w) &&
        Number.isFinite(parsed.h)
      )
        return clampRect(parsed as DesktopWindowRect)
    }
  } catch {
    /* localStorage 不可用时用默认位置 */
  }
  return defaultRect()
}

function writeRect(rect: DesktopWindowRect) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rect))
  } catch {
    /* localStorage 不可用时静默 */
  }
}

interface DragState {
  mode: 'move' | ResizeDir
  startX: number
  startY: number
  rect: DesktopWindowRect
}

// 四边 + 四角的隐形热区：只改光标，不渲染可见把手
const RESIZE_ZONES: { dir: ResizeDir; className: string }[] = [
  { dir: 'n', className: 'absolute inset-x-4 top-0 h-1.5 cursor-n-resize' },
  { dir: 's', className: 'absolute inset-x-4 bottom-0 h-1.5 cursor-s-resize' },
  { dir: 'w', className: 'absolute inset-y-4 left-0 w-1.5 cursor-w-resize' },
  { dir: 'e', className: 'absolute inset-y-4 right-0 w-1.5 cursor-e-resize' },
  { dir: 'nw', className: 'absolute left-0 top-0 h-4 w-4 cursor-nwse-resize' },
  { dir: 'ne', className: 'absolute right-0 top-0 h-4 w-4 cursor-nesw-resize' },
  { dir: 'sw', className: 'absolute bottom-0 left-0 h-4 w-4 cursor-nesw-resize' },
  { dir: 'se', className: 'absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize' },
]

export function DesktopWindow({ windowed, children }: { windowed: boolean; children: ReactNode }) {
  const [rect, setRect] = useState<DesktopWindowRect>(readRect)
  const dragRef = useRef<DragState | null>(null)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!windowed || event.button !== 0) return
      const target = event.target as HTMLElement
      const zone = target.closest<HTMLElement>('[data-desktop-resize]')?.dataset.desktopResize as ResizeDir | undefined
      if (!zone) {
        // 标题栏空白处拖动移动窗口；落在按钮/输入等交互元素上不触发
        if (
          !target.closest('[data-desktop-titlebar]') ||
          target.closest('button, input, select, textarea, a, [role="button"], [role="combobox"], [role="option"]')
        )
          return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { mode: zone ?? 'move', startX: event.clientX, startY: event.clientY, rect }
      event.preventDefault()
    },
    [windowed, rect],
  )

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    const start = drag.rect
    if (drag.mode === 'move') {
      setRect(clampRect({ ...start, x: start.x + dx, y: start.y + dy }))
      return
    }
    let { x, y, w, h } = start
    if (drag.mode.includes('e')) w = start.w + dx
    if (drag.mode.includes('s')) h = start.h + dy
    if (drag.mode.includes('w')) {
      w = start.w - dx
      x = start.x + dx
    }
    if (drag.mode.includes('n')) {
      h = start.h - dy
      y = start.y + dy
    }
    // 拖到最小尺寸时西/北边不再继续吃掉位置，避免对侧边被反向推走
    if (w < MIN_W) {
      if (drag.mode.includes('w')) x += w - MIN_W
      w = MIN_W
    }
    if (h < MIN_H) {
      if (drag.mode.includes('n')) y += h - MIN_H
      h = MIN_H
    }
    setRect(clampRect({ x, y, w, h }))
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    setRect((current) => {
      writeRect(current)
      return current
    })
  }, [])

  return (
    <div
      className={
        windowed
          ? 'pointer-events-auto absolute overflow-hidden rounded-apple-lg border border-[var(--line)] bg-bg-0 shadow-2xl'
          : 'h-full w-full'
      }
      style={windowed ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {children}
      {windowed &&
        RESIZE_ZONES.map(({ dir, className }) => (
          <div key={dir} data-desktop-resize={dir} className={`${className} touch-none`} />
        ))}
    </div>
  )
}
