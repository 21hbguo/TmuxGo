'use client'
import { useCallback, useState } from 'react'
import { formatDroppedPaths } from '@/lib/path-drop'

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
    const text = formatDroppedPaths(e.dataTransfer)
    if (text) onInput(text)
  }, [onInput, openUploadDialog])
  return { isDropActive, handleDragOver, handleDragLeave, handleDrop }
}
