'use client'

import { useCallback, useMemo, useRef } from 'react'

interface UseTerminalTouchScrollOptions {
  isMobile: boolean
  onScroll: (lines: number) => void
  onTap: (x: number, y: number) => void
  onTouchMovedChange: (moved: boolean) => void
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  onTwoFingerTap?: (x: number, y: number) => void
}

const TWO_FINGER_TAP_MS = 800
const TWO_FINGER_MOVE_PX = 72
const TWO_FINGER_PINCH_PX = 40

export function useTerminalTouchScroll({ isMobile, onScroll, onTap, onTouchMovedChange, onSwipeLeft, onSwipeRight, onTwoFingerTap }: UseTerminalTouchScrollOptions) {
  const lastTapRef = useRef<{ x: number; y: number } | null>(null)
  const onTwoFingerTapRef = useRef(onTwoFingerTap)
  onTwoFingerTapRef.current = onTwoFingerTap
  const twoFingerRef = useRef({
    active: false,
    valid: false,
    fired: false,
    startTime: 0,
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
    id0: -1,
    id1: -1,
    distance: 0,
  })
  const stateRef = useRef({
    startY: 0,
    startX: 0,
    lastY: 0,
    carryY: 0,
    moved: false,
    direction: 'unknown' as 'unknown' | 'vertical' | 'horizontal',
    momentumId: 0,
    startTime: 0,
    lastMoveTime: 0,
    lastVelocity: 0,
    momentumTimer: null as ReturnType<typeof setTimeout> | null,
  })
  const clearMomentum = useCallback(() => {
    stateRef.current.momentumId += 1
    const timer = stateRef.current.momentumTimer
    if (!timer) return
    clearTimeout(timer)
    stateRef.current.momentumTimer = null
  }, [])
  const resetTwoFinger = useCallback(() => {
    twoFingerRef.current.active = false
    twoFingerRef.current.valid = false
    twoFingerRef.current.fired = false
    twoFingerRef.current.startTime = 0
    twoFingerRef.current.distance = 0
    twoFingerRef.current.id0 = -1
    twoFingerRef.current.id1 = -1
  }, [])
  const armTwoFinger = useCallback((touches: TouchList) => {
    if (touches.length !== 2 || !onTwoFingerTapRef.current) {
      resetTwoFinger()
      return
    }
    const a = touches[0]
    const b = touches[1]
    twoFingerRef.current = {
      active: true,
      valid: true,
      fired: false,
      startTime: performance.now(),
      x0: a.clientX,
      y0: a.clientY,
      x1: b.clientX,
      y1: b.clientY,
      id0: a.identifier,
      id1: b.identifier,
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    }
  }, [resetTwoFinger])
  const findTouch = (touches: TouchList, id: number) => {
    for (let i = 0; i < touches.length; i += 1) {
      if (touches[i].identifier === id) return touches[i]
    }
    return null
  }
  const invalidateTwoFingerIfMoved = useCallback((touches: TouchList) => {
    const state = twoFingerRef.current
    if (!state.active || !state.valid) return
    const a = findTouch(touches, state.id0) || touches[0]
    const b = findTouch(touches, state.id1) || touches[1]
    if (!a || !b) return
    const move0 = Math.hypot(a.clientX - state.x0, a.clientY - state.y0)
    const move1 = Math.hypot(b.clientX - state.x1, b.clientY - state.y1)
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (move0 > TWO_FINGER_MOVE_PX || move1 > TWO_FINGER_MOVE_PX || Math.abs(distance - state.distance) > TWO_FINGER_PINCH_PX) {
      state.valid = false
    }
  }, [])
  const tryFireTwoFingerTap = useCallback(() => {
    const state = twoFingerRef.current
    if (!state.active || !state.valid || state.fired || !onTwoFingerTapRef.current) return false
    if (performance.now() - state.startTime > TWO_FINGER_TAP_MS) return false
    state.fired = true
    stateRef.current.moved = true
    onTouchMovedChange(true)
    lastTapRef.current = null
    onTwoFingerTapRef.current((state.x0 + state.x1) / 2, (state.y0 + state.y1) / 2)
    return true
  }, [onTouchMovedChange])
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!isMobile) return
    lastTapRef.current = null
    clearMomentum()
    stateRef.current.carryY = 0
    if (e.touches.length >= 2) {
      stateRef.current.startY = 0
      stateRef.current.startX = 0
      stateRef.current.lastY = 0
      stateRef.current.startTime = performance.now()
      stateRef.current.lastMoveTime = stateRef.current.startTime
      stateRef.current.lastVelocity = 0
      stateRef.current.moved = true
      stateRef.current.direction = 'horizontal'
      onTouchMovedChange(true)
      if (e.touches.length === 2) armTwoFinger(e.touches)
      else resetTwoFinger()
      return
    }
    resetTwoFinger()
    stateRef.current.startY = e.touches[0].clientY
    stateRef.current.startX = e.touches[0].clientX
    stateRef.current.lastY = stateRef.current.startY
    stateRef.current.startTime = performance.now()
    stateRef.current.lastMoveTime = stateRef.current.startTime
    stateRef.current.lastVelocity = 0
    stateRef.current.moved = false
    stateRef.current.direction = 'unknown'
    onTouchMovedChange(false)
  }, [armTwoFinger, clearMomentum, isMobile, onTouchMovedChange, resetTwoFinger])
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isMobile) return
    if (e.touches.length >= 2) {
      invalidateTwoFingerIfMoved(e.touches)
      stateRef.current.moved = true
      onTouchMovedChange(true)
      return
    }
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
    if (stateRef.current.direction !== 'vertical') {
      if (stateRef.current.direction === 'horizontal') e.preventDefault()
      return
    }
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
    onScroll(Math.max(-18, Math.min(18, step * 2)))
  }, [invalidateTwoFingerIfMoved, isMobile, onScroll, onTouchMovedChange])
  const SWIPE_THRESHOLD = 50
  const handleTouchEnd = useCallback((e: TouchEvent) => {
    const twoFinger = twoFingerRef.current
    if (twoFinger.active && e.touches.length < 2) {
      const fired = tryFireTwoFingerTap()
      if (e.touches.length === 0) resetTwoFinger()
      else {
        twoFinger.active = false
        twoFinger.valid = false
      }
      if (fired) return
    }
    onTouchMovedChange(stateRef.current.moved)
    const touch = e.changedTouches[0]
    if (!touch) return
    const totalDx = touch.clientX - stateRef.current.startX
    const totalDy = Math.abs(touch.clientY - stateRef.current.startY)
    if (stateRef.current.direction === 'horizontal') {
      if (Math.abs(totalDx) >= SWIPE_THRESHOLD && totalDy < 80) {
        if (totalDx < 0) onSwipeLeft?.()
        else onSwipeRight?.()
      }
      return
    }
    if (stateRef.current.direction !== 'vertical') {
      if (!stateRef.current.moved && Math.abs(totalDx) < 10 && totalDy < 10 && performance.now() - stateRef.current.startTime < 250) {
        lastTapRef.current = { x: touch.clientX, y: touch.clientY }
        onTap(touch.clientX, touch.clientY)
      }
      return
    }
    if (Math.abs(totalDx) < 10 && totalDy < 10 && performance.now() - stateRef.current.startTime < 250) {
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
  }, [onScroll, onTap, onTouchMovedChange, onSwipeLeft, onSwipeRight, resetTwoFinger, tryFireTwoFingerTap])
  const handleTouchCancel = useCallback(() => {
    clearMomentum()
    resetTwoFinger()
    stateRef.current.carryY = 0
    stateRef.current.moved = false
    stateRef.current.direction = 'unknown'
    lastTapRef.current = null
    onTouchMovedChange(false)
  }, [clearMomentum, onTouchMovedChange, resetTwoFinger])
  const dispose = useCallback(() => {
    clearMomentum()
    resetTwoFinger()
  }, [clearMomentum, resetTwoFinger])
  return useMemo(() => ({
    dispose,
    handleTouchCancel,
    handleTouchEnd,
    handleTouchMove,
    handleTouchStart,
    lastTapRef,
  }), [dispose, handleTouchCancel, handleTouchEnd, handleTouchMove, handleTouchStart])
}
