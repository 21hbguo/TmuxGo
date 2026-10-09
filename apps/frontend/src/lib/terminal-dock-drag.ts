export const TERMINAL_DOCK_DRAG_MIME = 'application/x-tmuxgo-terminal-dock'
// 窗口 tab 排序拖拽的 MIME；拖出 tab 条后由 DesktopWorkbench 转换为停靠拖拽
export const WINDOW_TAB_DRAG_MIME = 'application/x-tmuxgo-window'
let active = false
export function setTerminalDockDragActive(value: boolean) {
  active = value
}
// dragover/drop 阶段 getData 读不到自定义 MIME 内容，只能靠 types + 模块内标记识别
export function isTerminalDockDrag(dataTransfer?: DataTransfer | null) {
  return active || !!dataTransfer?.types?.includes(TERMINAL_DOCK_DRAG_MIME)
}
// tab 拖出条外才算停靠拖拽；条缘留 8px 滞回，避免擦边抖动反复开关 zones
export function isOutsideWindowStrip(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | null | undefined,
  x: number,
  y: number,
) {
  if (!rect) return true
  return x < rect.left || x > rect.right || y < rect.top - 8 || y > rect.bottom + 8
}
