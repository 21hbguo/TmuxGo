export const TERMINAL_DOCK_DRAG_MIME = 'application/x-tmuxgo-terminal-dock'
let active = false
export function setTerminalDockDragActive(value: boolean) {
  active = value
}
// dragover/drop 阶段 getData 读不到自定义 MIME 内容，只能靠 types + 模块内标记识别
export function isTerminalDockDrag(dataTransfer?: DataTransfer | null) {
  return active || !!dataTransfer?.types?.includes(TERMINAL_DOCK_DRAG_MIME)
}
