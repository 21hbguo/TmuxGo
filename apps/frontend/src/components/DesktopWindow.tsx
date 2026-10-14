'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import type { DesktopViewMode } from '@/stores/useConsoleStore'

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

const TITLEBAR_INTERACTIVE = 'button, input, select, textarea, a, [role="button"], [role="combobox"], [role="option"]'
// 标题栏空白区（可拖动/双击区）：在 titlebar 内但不在按钮/输入等交互元素上
const isTitlebarBlank = (target: HTMLElement) =>
  !!target.closest('[data-desktop-titlebar]') && !target.closest(TITLEBAR_INTERACTIVE)

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

export function DesktopWindow({
  windowed,
  onTitlebarDoubleClick,
  children,
}: {
  windowed: boolean
  onTitlebarDoubleClick?: () => void
  children: ReactNode
}) {
  const [rect, setRect] = useState<DesktopWindowRect>(readRect)
  const [maximized, setMaximized] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  // 标题栏 tap 计时：pointer capture 会把 click/dblclick 重定向到容器，原生 dblclick 的
  // target 拿不到 titlebar，故 windowed 态双击用 pointer 序列自测（两次近距 tap <450ms）
  const lastTitlebarTapRef = useRef<{ t: number; x: number; y: number }>({ t: 0, x: 0, y: 0 })

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!windowed || event.button !== 0) return
      const target = event.target as HTMLElement
      const zone = target.closest<HTMLElement>('[data-desktop-resize]')?.dataset.desktopResize as ResizeDir | undefined
      if (!zone) {
        // 标题栏空白处拖动移动窗口；落在按钮/输入等交互元素上不触发
        if (!isTitlebarBlank(target)) {
          lastTitlebarTapRef.current = { t: 0, x: 0, y: 0 }
          return
        }
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { mode: zone ?? 'move', startX: event.clientX, startY: event.clientY, rect }
      // 仅边缘 resize 手势上报 burst 生命周期；标题栏 move 不改变容器尺寸
      if (zone) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
      event.preventDefault()
    },
    [windowed, rect],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      const start = drag.rect
      if (drag.mode === 'move') {
        // 最大化态标题栏仍可按下（供双击还原计数）但拖动不生效
        if (!maximized) setRect(clampRect({ ...start, x: start.x + dx, y: start.y + dy }))
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
    },
    [maximized],
  )

  // 卸载兜底：拖拽中组件消失时补 end，否则 PaneGrid 的 burst 抑制会永久卡住
  useEffect(
    () => () => {
      if (dragRef.current && dragRef.current.mode !== 'move')
        emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
    },
    [],
  )

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const wasResize = drag.mode !== 'move'
    dragRef.current = null
    if (wasResize) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (drag.mode === 'move') {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      const now = performance.now()
      const last = lastTitlebarTapRef.current
      const isDouble =
        moved <= 4 &&
        last.t > 0 &&
        now - last.t < 450 &&
        Math.abs(event.clientX - last.x) <= 24 &&
        Math.abs(event.clientY - last.y) <= 24
      lastTitlebarTapRef.current =
        moved <= 4 && !isDouble ? { t: now, x: event.clientX, y: event.clientY } : { t: 0, x: 0, y: 0 }
      if (isDouble) setMaximized((value) => !value)
    }
    setRect((current) => {
      writeRect(current)
      return current
    })
  }, [])

  // full 态无 pointer capture,dblclick target 真实可用：标题栏空白区双击 = 缩小回浮窗。
  // windowed 态的双击由 onPointerUp 的 tap 序列判定
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (windowed || !onTitlebarDoubleClick || !isTitlebarBlank(event.target as HTMLElement)) return
      onTitlebarDoubleClick()
    },
    [windowed, onTitlebarDoubleClick],
  )

  return (
    <div
      className={
        windowed
          ? `pointer-events-auto absolute overflow-hidden rounded-apple-lg border border-[var(--line)] bg-bg-0 shadow-2xl ${
              maximized ? 'inset-0' : ''
            }`
          : 'h-full w-full'
      }
      style={windowed && !maximized ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {children}
      {windowed &&
        !maximized &&
        RESIZE_ZONES.map(({ dir, className }) => (
          <div key={dir} data-desktop-resize={dir} className={`${className} touch-none`} />
        ))}
    </div>
  )
}

// desktop/browser 共用覆盖层外壳：全屏铺满不透明底色；浮窗整体指针穿透、仅窗口本体可交互。
// 非置顶浮窗外挂点击板——点背景吸收点击并最小化（不会误触到底层 UI）；置顶后不挂。
// minimized 用 visibility 隐藏而非卸载：子树保持挂载，RFB/WS 连接不断开
export function OverlayShell({
  overlay,
  onBackdropMinimize,
  onTitlebarDoubleClick,
  children,
}: {
  overlay: { view: DesktopViewMode; minimized: boolean; pinned?: boolean }
  onBackdropMinimize: () => void
  onTitlebarDoubleClick?: () => void
  children: ReactNode
}) {
  return (
    <div
      className={`fixed inset-0 z-[85] ${
        overlay.minimized ? 'invisible' : overlay.view === 'window' ? 'pointer-events-none' : 'bg-bg-0'
      }`}
      style={{ height: 'var(--app-height,100dvh)' }}
    >
      {overlay.view === 'window' && !overlay.pinned && (
        <div className="pointer-events-auto absolute inset-0" onPointerDown={onBackdropMinimize} />
      )}
      <DesktopWindow windowed={overlay.view === 'window'} onTitlebarDoubleClick={onTitlebarDoubleClick}>
        {children}
      </DesktopWindow>
    </div>
  )
}
