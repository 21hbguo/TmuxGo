'use client'

import { useEffect } from 'react'

// pointer illumination：把鼠标位置写入所有 .tmuxgo-keycap/.tmuxgo-chip/.tmuxgo-button 的 --mx/--my
// 全局 event delegation，单一 listener 覆盖所有按钮
export function GlassPointerEffect() {
  useEffect(() => {
    let raf = 0
    const targets = new Set<Element>()
    const onMove = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (!el || !el.closest) return
      const btn = el.closest('.tmuxgo-keycap, .tmuxgo-chip, .tmuxgo-button')
      if (!btn) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = btn.getBoundingClientRect()
        ;(btn as HTMLElement).style.setProperty('--mx', `${e.clientX - r.left}px`)
        ;(btn as HTMLElement).style.setProperty('--my', `${e.clientY - r.top}px`)
      })
    }
    const onLeave = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (!el || !el.closest) return
      const btn = el.closest('.tmuxgo-keycap, .tmuxgo-chip, .tmuxgo-button')
      if (btn) targets.delete(btn)
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave, true)
    }
  }, [])
  return null
}
