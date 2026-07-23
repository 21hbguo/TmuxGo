'use client'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { isMobileBrowser, usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'

const POS_KEY = 'tmuxgo-immersive-back-orb'
const SIZE = 48
const DRAG_THRESHOLD = 8

function readSafeInset(side: 'top' | 'bottom' | 'left' | 'right') {
  const probe = document.createElement('div')
  probe.style.cssText = `position:fixed;visibility:hidden;padding-${side}:env(safe-area-inset-${side})`
  document.body.appendChild(probe)
  const value = parseFloat(getComputedStyle(probe).getPropertyValue(`padding-${side}`) || '0') || 0
  probe.remove()
  return value
}

function clampPos(x: number, y: number) {
  const margin = 8
  const topInset = readSafeInset('top')
  const bottomInset = readSafeInset('bottom')
  const leftInset = readSafeInset('left')
  const rightInset = readSafeInset('right')
  const maxX = Math.max(margin + leftInset, window.innerWidth - SIZE - margin - rightInset)
  const maxY = Math.max(margin + topInset, window.innerHeight - SIZE - margin - bottomInset)
  return {
    x: Math.min(maxX, Math.max(margin + leftInset, x)),
    y: Math.min(maxY, Math.max(margin + topInset, y)),
  }
}

function defaultPos() {
  return clampPos(window.innerWidth - SIZE - 16, Math.round(window.innerHeight * 0.55))
}

function readPos() {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null
    return { x: raw.x, y: raw.y }
  } catch {
    return null
  }
}

export function ImmersiveBackOrb() {
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [ready, setReady] = useState(false)
  const dragRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    dragging: false,
    moved: false,
  })
  const visible = preferences.immersiveFullscreen && isMobileBrowser()

  useEffect(() => {
    if (!visible) {
      setReady(false)
      return
    }
    const saved = readPos()
    setPos(saved ? clampPos(saved.x, saved.y) : defaultPos())
    setReady(true)
    const onResize = () => setPos((prev) => clampPos(prev.x, prev.y))
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [visible])

  const handleAppBack = useCallback(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-app-back'))
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
      dragging: true,
      moved: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = dragRef.current
    if (!state.dragging || state.pointerId !== event.pointerId) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    state.moved = true
    setPos(clampPos(state.originX + dx, state.originY + dy))
  }

  const finishPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = dragRef.current
    if (!state.dragging || state.pointerId !== event.pointerId) return
    state.dragging = false
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {}
    if (state.moved) {
      setPos((prev) => {
        const next = clampPos(prev.x, prev.y)
        localStorage.setItem(POS_KEY, JSON.stringify(next))
        return next
      })
      return
    }
    handleAppBack()
  }

  if (!visible || !ready) return null

  return (
    <button
      type="button"
      data-immersive-back-orb
      aria-label={t('immersive.backOrb')}
      title={t('immersive.backOrbHint')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onContextMenu={(e) => e.preventDefault()}
      className="tmuxgo-glass fixed z-[120] flex h-12 w-12 touch-none select-none items-center justify-center rounded-full border text-xs font-medium text-text-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)] active:scale-95"
      style={{ left: pos.x, top: pos.y }}
    >
      {t('immersive.backOrb')}
    </button>
  )
}
