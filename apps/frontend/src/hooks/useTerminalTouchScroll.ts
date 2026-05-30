'use client'

import { useCallback, useMemo, useRef } from 'react'

interface UseTerminalTouchScrollOptions {
  isMobile: boolean
  onScroll: (lines: number) => void
  onTap: (x: number, y: number) => void
  onTouchMovedChange: (moved: boolean) => void
}

export function useTerminalTouchScroll({ isMobile, onScroll, onTap, onTouchMovedChange }: UseTerminalTouchScrollOptions) {
  const lastTapRef = useRef<{ x: number; y: number } | null>(null)
  const stateRef = useRef({
    startY: 0,
    startX: 0,
    lastY: 0,
    carryY: 0,
    moved: false,
    direction: 'unknown' as 'unknown' | 'vertical' | 'horizontal',
    scrollPendingLines: 0,
    scrollFlushTimer: null as ReturnType<typeof setTimeout> | null,
    momentumId: 0,
    startTime: 0,
    lastMoveTime: 0,
    lastVelocity: 0,
    momentumTimer: null as ReturnType<typeof setTimeout> | null,
  })
  const clearScrollFlush = useCallback(() => {
    const timer = stateRef.current.scrollFlushTimer
    if (!timer) return
    clearTimeout(timer)
    stateRef.current.scrollFlushTimer = null
  }, [])
  const clearMomentum = useCallback(() => {
    stateRef.current.momentumId += 1
    const timer = stateRef.current.momentumTimer
    if (!timer) return
    clearTimeout(timer)
    stateRef.current.momentumTimer = null
  }, [])
  const flushScroll = useCallback(() => {
    stateRef.current.scrollFlushTimer = null
    const lines = Math.trunc(stateRef.current.scrollPendingLines)
    stateRef.current.scrollPendingLines = 0
    if (!lines) return
    onScroll(Math.max(-18, Math.min(18, lines)))
  }, [onScroll])
  const queueScroll = useCallback((lines: number) => {
    stateRef.current.scrollPendingLines += lines
    if (stateRef.current.scrollFlushTimer) return
    stateRef.current.scrollFlushTimer = setTimeout(flushScroll, 16)
  }, [flushScroll])
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!isMobile) return
    lastTapRef.current = null
    clearMomentum()
    clearScrollFlush()
    stateRef.current.scrollPendingLines = 0
    stateRef.current.carryY = 0
    if (e.touches.length !== 1) {
      stateRef.current.startY = 0
      stateRef.current.startX = 0
      stateRef.current.lastY = 0
      stateRef.current.startTime = performance.now()
      stateRef.current.lastMoveTime = stateRef.current.startTime
      stateRef.current.lastVelocity = 0
      stateRef.current.moved = true
      stateRef.current.direction = 'horizontal'
      onTouchMovedChange(true)
      return
    }
    stateRef.current.startY = e.touches[0].clientY
    stateRef.current.startX = e.touches[0].clientX
    stateRef.current.lastY = stateRef.current.startY
    stateRef.current.startTime = performance.now()
    stateRef.current.lastMoveTime = stateRef.current.startTime
    stateRef.current.lastVelocity = 0
    stateRef.current.moved = false
    stateRef.current.direction = 'unknown'
    onTouchMovedChange(false)
  }, [clearMomentum, clearScrollFlush, isMobile, onTouchMovedChange])
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isMobile) return
    if (e.touches.length !== 1) {
      stateRef.current.moved = true
      onTouchMovedChange(true)
      return
    }
    const x = e.touches[0].clientX
    const y = e.touches[0].clientY
    const dx = Math.abs(x - stateRef.current.startX)
    const dy = Math.abs(y - stateRef.current.startY)
    if (dx < 8 && dy < 8) return
    if (stateRef.current.direction === 'unknown') {
      stateRef.current.direction = dx > dy ? 'horizontal' : 'vertical'
    }
    if (stateRef.current.direction !== 'vertical') return
    if (dy < 10) return
    stateRef.current.moved = true
    onTouchMovedChange(true)
    e.preventDefault()
    const now = performance.now()
    const deltaY = y - stateRef.current.lastY
    const deltaTime = Math.max(1, now - stateRef.current.lastMoveTime)
    stateRef.current.lastY = y
    stateRef.current.lastMoveTime = now
    stateRef.current.carryY += deltaY
    stateRef.current.lastVelocity = deltaY / deltaTime
    const step = Math.trunc(stateRef.current.carryY / 18)
    if (step === 0) return
    stateRef.current.carryY -= step * 18
    queueScroll(step * 2)
  }, [isMobile, onTouchMovedChange, queueScroll])
  const handleTouchEnd = useCallback((e: TouchEvent) => {
    clearScrollFlush()
    if (stateRef.current.scrollPendingLines) flushScroll()
    onTouchMovedChange(stateRef.current.moved)
    if (stateRef.current.direction !== 'vertical') return
    const touch = e.changedTouches[0]
    if (!touch) return
    const totalDx = Math.abs(touch.clientX - stateRef.current.startX)
    const totalDy = Math.abs(touch.clientY - stateRef.current.startY)
    if (totalDx < 10 && totalDy < 10 && performance.now() - stateRef.current.startTime < 250) {
      lastTapRef.current = { x: touch.clientX, y: touch.clientY }
      onTap(touch.clientX, touch.clientY)
      return
    }
    let velocity = stateRef.current.lastVelocity
    if (Math.abs(velocity) < 0.2) return
    const id = ++stateRef.current.momentumId
    const decay = () => {
      if (stateRef.current.momentumId !== id) return
      velocity *= 0.92
      if (Math.abs(velocity) < 0.2) {
        stateRef.current.momentumTimer = null
        return
      }
      const lines = Math.max(-6, Math.min(6, Math.round(velocity * 8)))
      if (lines !== 0) onScroll(lines)
      stateRef.current.momentumTimer = setTimeout(decay, 16)
    }
    stateRef.current.momentumTimer = setTimeout(decay, 16)
  }, [clearScrollFlush, flushScroll, onScroll, onTap, onTouchMovedChange])
  const handleTouchCancel = useCallback(() => {
    clearScrollFlush()
    clearMomentum()
    stateRef.current.scrollPendingLines = 0
    stateRef.current.carryY = 0
    stateRef.current.moved = false
    stateRef.current.direction = 'unknown'
    lastTapRef.current = null
    onTouchMovedChange(false)
  }, [clearMomentum, clearScrollFlush, onTouchMovedChange])
  const dispose = useCallback(() => {
    clearScrollFlush()
    clearMomentum()
  }, [clearMomentum, clearScrollFlush])
  return useMemo(() => ({
    dispose,
    handleTouchCancel,
    handleTouchEnd,
    handleTouchMove,
    handleTouchStart,
    lastTapRef,
  }), [dispose, handleTouchCancel, handleTouchEnd, handleTouchMove, handleTouchStart])
}
