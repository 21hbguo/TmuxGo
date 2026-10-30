// 三区缩放统一入口：Ctrl+滚轮按指针区域、Ctrl+±/0 按焦点区域路由。
// 必须在 window 捕获阶段拦：CM6/Monaco/xterm 都可能自己处理滚轮，浏览器还会整页 zoom。
import { useEffect, useRef } from 'react'
import {
  applyZoneZoom,
  isZoomShortcut,
  resetZoneZoom,
  zoomZoneForFocus,
  zoomZoneForTarget,
  type ZoomZone,
} from '@/lib/workspace-zoom'

const WHEEL_STEP_THRESHOLD = 40
const WHEEL_GESTURE_RESET_MS = 400

export function useZoneZoom(): void {
  const wheelRef = useRef({ zone: 'ui' as ZoomZone, delta: 0, at: 0 })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isZoomShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      const zone = zoomZoneForFocus()
      if (event.key === '0') resetZoneZoom(zone)
      else applyZoneZoom(zone, event.key === '-' || event.key === '_' ? -1 : 1)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      event.stopPropagation()
      const zone = zoomZoneForTarget(event.target)
      const now = performance.now()
      const state = wheelRef.current
      if (zone !== state.zone || now - state.at > WHEEL_GESTURE_RESET_MS) state.delta = 0
      state.zone = zone
      state.at = now
      // 鼠标滚轮一格 ~100，触控板捏合/滚动是 1~10 的连续小值；累积过阈值再走一档
      state.delta += event.deltaY * (event.deltaMode === 1 ? 16 : 1)
      if (Math.abs(state.delta) < WHEEL_STEP_THRESHOLD) return
      applyZoneZoom(zone, state.delta < 0 ? 1 : -1)
      state.delta = 0
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [])
}
