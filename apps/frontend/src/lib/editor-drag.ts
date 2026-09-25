import type { FileDocumentHandle } from '@/types'
export const FILE_DRAG_MIME = 'application/x-tmuxgo-file'
let activeDraggedFile: FileDocumentHandle | null = null
export function setActiveDraggedFile(file: FileDocumentHandle) {
  activeDraggedFile = file
}
export function getActiveDraggedFile() {
  return activeDraggedFile
}
export function clearActiveDraggedFile() {
  activeDraggedFile = null
}
export function readDraggedFile(dataTransfer?: DataTransfer | null) {
  const raw = dataTransfer?.getData(FILE_DRAG_MIME)
  if (raw) {
    try {
      return JSON.parse(raw) as FileDocumentHandle
    } catch {}
  }
  return activeDraggedFile
}
// 划词/取词类桌面工具(如有道翻译)会在拖拽结束时向焦点窗口合成 Ctrl+C 抢剪贴板,
// 该伪 ^C 到达终端会清掉输入行。记录拖拽活动时间,让终端在短窗口内吞掉一次 Ctrl+C。
let lastDragActivityAt = 0
if (typeof window !== 'undefined') {
  const markDragActivity = () => {
    lastDragActivityAt = Date.now()
  }
  window.addEventListener('dragover', markDragActivity)
  window.addEventListener('dragend', markDragActivity)
}
export function consumeRecentDragGuard(windowMs = 900) {
  if (!lastDragActivityAt || Date.now() - lastDragActivityAt >= windowMs) return false
  lastDragActivityAt = 0
  return true
}
