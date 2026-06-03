'use client'
import { useCallback, useMemo, useState } from 'react'
import { formatDroppedPaths, quoteShellPath } from '@/lib/path-drop'
import { readDraggedFile } from '@/lib/editor-drag'

export function useTerminalDrop(onInput: (data: string) => void, openUploadDialog: (request: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean }) => void) {
  const [isDropActive, setIsDropActive] = useState(false)
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDropActive(true)
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [])
  const handleDragLeave = useCallback((e: DragEvent, container: HTMLElement) => {
    if (!container.contains(e.relatedTarget as Node | null)) setIsDropActive(false)
  }, [])
  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDropActive(false)
    if (e.dataTransfer?.files?.length) {
      openUploadDialog({ files: Array.from(e.dataTransfer.files), insertPaths: true })
      return
    }
    const draggedFile = readDraggedFile(e.dataTransfer)
    if (draggedFile?.absolutePath) {
      onInput(quoteShellPath(draggedFile.absolutePath))
      return
    }
    const text = formatDroppedPaths(e.dataTransfer)
    if (text) onInput(text)
  }, [onInput, openUploadDialog])
  return useMemo(() => ({ isDropActive, handleDragOver, handleDragLeave, handleDrop }), [isDropActive, handleDragOver, handleDragLeave, handleDrop])
}
