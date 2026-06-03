import type { FileDocumentHandle } from '@/types'
export const FILE_DRAG_MIME='application/x-tmuxgo-file'
let activeDraggedFile:FileDocumentHandle|null = null
export function setActiveDraggedFile(file: FileDocumentHandle) {
  activeDraggedFile = file
}
export function getActiveDraggedFile() {
  return activeDraggedFile
}
export function clearActiveDraggedFile() {
  activeDraggedFile = null
}
export function readDraggedFile(dataTransfer?: DataTransfer|null) {
  const raw=dataTransfer?.getData(FILE_DRAG_MIME)
  if (raw) {
    try {
      return JSON.parse(raw) as FileDocumentHandle
    } catch {}
  }
  return activeDraggedFile
}
