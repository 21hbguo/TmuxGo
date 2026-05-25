'use client'

import { useEffect } from 'react'

export function DropGuard() {
  useEffect(() => {
    const guard = (e: DragEvent) => {
      const target = e.target
      if (target instanceof Element && target.closest('[data-terminal]')) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', guard, true)
    window.addEventListener('drop', guard, true)
    return () => {
      window.removeEventListener('dragover', guard, true)
      window.removeEventListener('drop', guard, true)
    }
  }, [])
  return null
}
