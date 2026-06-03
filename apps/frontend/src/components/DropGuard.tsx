'use client'
import { useEffect } from 'react'
import { FILE_DRAG_MIME, getActiveDraggedFile } from '@/lib/editor-drag'

export function DropGuard() {
  useEffect(() => {
    const hasInternalFileDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types ? Array.from(e.dataTransfer.types) : []
      return types.includes(FILE_DRAG_MIME) || !!getActiveDraggedFile()
    }
    const guard = (e: DragEvent) => {
      const target = e.target
      if (target instanceof Element && target.closest('[data-terminal]')) return
      if (target instanceof Element && target.closest('[data-editor-drop]') && hasInternalFileDrag(e)) return
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
