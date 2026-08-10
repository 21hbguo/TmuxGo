'use client'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
interface ZoomSurfaceProps {
  children: ReactNode
  className?: string
  active?: boolean
  image?: boolean
  resetKey?: string | number
  minScale?: number
  maxScale?: number
  doubleClickZoom?: boolean
}
function getTouchDistance(touches: TouchList) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
}
function clampScale(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
export function ZoomSurface({ children, className, active = true, image = false, resetKey, minScale = 0.25, maxScale = 8, doubleClickZoom = true }: ZoomSurfaceProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [sized, setSized] = useState(false)
  const scaleRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null)
  const gestureRef = useRef<number | null>(null)
  const touchDragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null)
  const updateScale = useCallback((next: number) => {
    const clamped = clampScale(next, minScale, maxScale)
    scaleRef.current = clamped
    setScale(clamped)
  }, [minScale, maxScale])
  const updateOffset = useCallback((next: { x: number; y: number }) => {
    offsetRef.current = next
    setOffset(next)
  }, [])
  useLayoutEffect(() => {
    if (image) return
    const el = contentRef.current
    if (!el) return
    const measure = () => setNatural({ w: el.scrollWidth, h: el.scrollHeight })
    measure()
    setSized(true)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [image, resetKey])
  useEffect(() => {
    updateScale(1)
    updateOffset({ x: 0, y: 0 })
  }, [resetKey, updateOffset, updateScale])
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !active) return
    const handleWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const next = clampScale(scaleRef.current * (event.deltaY < 0 ? 1.12 : 0.9), minScale, maxScale)
      const ratio = next / scaleRef.current
      if (image) {
        const pointX = event.clientX - rect.left - rect.width / 2 - offsetRef.current.x
        const pointY = event.clientY - rect.top - rect.height / 2 - offsetRef.current.y
        updateScale(next)
        updateOffset({ x: offsetRef.current.x - pointX * (ratio - 1), y: offsetRef.current.y - pointY * (ratio - 1) })
      } else {
        const pointX = event.clientX - rect.left + viewport.scrollLeft - offsetRef.current.x
        const pointY = event.clientY - rect.top + viewport.scrollTop - offsetRef.current.y
        updateScale(next)
        updateOffset({ x: offsetRef.current.x - pointX * (ratio - 1), y: offsetRef.current.y - pointY * (ratio - 1) })
      }
    }
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        pinchRef.current = { distance: getTouchDistance(event.touches), scale: scaleRef.current }
      } else if (event.touches.length === 1 && scaleRef.current > 1) {
        touchDragRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, originX: offsetRef.current.x, originY: offsetRef.current.y }
      }
    }
    const handleTouchMove = (event: TouchEvent) => {
      const pinch = pinchRef.current
      if (pinch && event.touches.length === 2) {
        event.preventDefault()
        updateScale(pinch.scale * getTouchDistance(event.touches) / pinch.distance)
        return
      }
      const drag = touchDragRef.current
      if (drag && event.touches.length === 1) {
        event.preventDefault()
        updateOffset({ x: drag.originX + event.touches[0].clientX - drag.x, y: drag.originY + event.touches[0].clientY - drag.y })
      }
    }
    const handleTouchEnd = () => {
      pinchRef.current = null
      touchDragRef.current = null
    }
    const handleGestureStart = (event: any) => {
      gestureRef.current = scaleRef.current / (event.scale || 1)
      event.preventDefault?.()
    }
    const handleGestureChange = (event: any) => {
      if (gestureRef.current === null) return
      event.preventDefault?.()
      updateScale(gestureRef.current * (event.scale || 1))
    }
    const handleGestureEnd = () => {
      gestureRef.current = null
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false })
    viewport.addEventListener('touchend', handleTouchEnd)
    viewport.addEventListener('touchcancel', handleTouchEnd)
    viewport.addEventListener('gesturestart', handleGestureStart)
    viewport.addEventListener('gesturechange', handleGestureChange)
    viewport.addEventListener('gestureend', handleGestureEnd)
    return () => {
      viewport.removeEventListener('wheel', handleWheel)
      viewport.removeEventListener('touchstart', handleTouchStart)
      viewport.removeEventListener('touchmove', handleTouchMove)
      viewport.removeEventListener('touchend', handleTouchEnd)
      viewport.removeEventListener('touchcancel', handleTouchEnd)
      viewport.removeEventListener('gesturestart', handleGestureStart)
      viewport.removeEventListener('gesturechange', handleGestureChange)
      viewport.removeEventListener('gestureend', handleGestureEnd)
    }
  }, [active, image, maxScale, minScale, updateOffset, updateScale])
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || event.pointerType !== 'mouse') return
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: offsetRef.current.x, originY: offsetRef.current.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || scaleRef.current <= 1) return
    updateOffset({ x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y })
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }
  const handleDoubleClick = () => {
    if (!active || !doubleClickZoom) return
    if (Math.abs(scaleRef.current - 1) < 0.01) updateScale(2)
    else {
      updateScale(1)
      updateOffset({ x: 0, y: 0 })
    }
  }
  const zoomBy = (factor: number) => {
    const viewport = viewportRef.current
    const next = clampScale(scaleRef.current * factor, minScale, maxScale)
    const ratio = next / scaleRef.current
    if (viewport && ratio !== 1) {
      if (image) updateOffset({ x: offsetRef.current.x * ratio, y: offsetRef.current.y * ratio })
      else {
        const cx = viewport.clientWidth / 2 + viewport.scrollLeft - offsetRef.current.x
        const cy = viewport.clientHeight / 2 + viewport.scrollTop - offsetRef.current.y
        updateOffset({ x: offsetRef.current.x - cx * (ratio - 1), y: offsetRef.current.y - cy * (ratio - 1) })
      }
    }
    updateScale(next)
  }
  const reset = () => {
    updateScale(1)
    updateOffset({ x: 0, y: 0 })
  }
  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
  return (
    <div ref={viewportRef} className={`${className} relative`} onDoubleClick={handleDoubleClick} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {image ? <div className="flex h-full w-full items-center justify-center" style={{ transform, transformOrigin: 'center center' }}>{children}</div> : <div style={sized ? { width: natural.w * scale, height: natural.h * scale } : undefined}><div ref={contentRef} style={sized ? { width: natural.w, transform, transformOrigin: '0 0' } : undefined}>{children}</div></div>}
      {active && <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-full border border-[var(--line)] bg-bg-1/90 px-1.5 py-1 text-meta text-text-2"><button type="button" onClick={() => zoomBy(1 / 1.25)} className="pointer-events-auto px-1.5 hover:text-accent">−</button><span className="min-w-9 text-center">{Math.round(scale * 100)}%</span><button type="button" onClick={() => zoomBy(1.25)} className="pointer-events-auto px-1.5 hover:text-accent">+</button><button type="button" onClick={reset} className="pointer-events-auto px-1.5 hover:text-accent">↺</button></div>}
    </div>
  )
}
