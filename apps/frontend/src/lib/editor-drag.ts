import type { FileDocumentHandle } from '@/types'
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
