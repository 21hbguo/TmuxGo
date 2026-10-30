// pane 拖拽的跨组件契约（HTML5 DnD）。
//
// dragover 阶段浏览器只暴露 dataTransfer.types，读不到自定义 MIME 的内容，所以
// 「当前拖的是哪个 pane」放在模块内单例里，窗口标签（WindowTabs）、pane 几何落点
// （PaneMoveOverlay）各自订阅；drop 阶段先读 dataTransfer，读不到再回落单例。
//
// MIME 与窗口标签排序（application/x-tmuxgo-window）、终端停靠
// （application/x-tmuxgo-terminal-dock）完全分开，三种手势互不串味。
export const PANE_DRAG_MIME = 'application/x-tmuxgo-pane'

export interface PaneDragPayload {
  paneId: string
  /** 源 pane 所在窗口：落在同一窗口的标签上不算移动 */
  windowId?: string
  title?: string
}

export type PaneDropSide = 'left' | 'right' | 'top' | 'bottom'
export type PaneMoveDirection = 'horizontal' | 'vertical'

export interface PaneDropRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PaneDropRegion {
  paneId: string
  title: string
  index: number
  /** 相对 window 的比例矩形（0..1），与 PaneNumberOverlay 的几何口径一致 */
  rect: PaneDropRect
}

let current: PaneDragPayload | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of [...listeners]) listener()
}

export function startPaneDrag(payload: PaneDragPayload) {
  if (!payload.paneId) return
  current = { ...payload }
  emit()
}

/** 传 paneId 时只在拖拽源的 dragend 才清，避免别的组件误清掉进行中的拖拽 */
export function endPaneDrag(paneId?: string) {
  if (!current) return
  if (paneId && current.paneId !== paneId) return
  current = null
  emit()
}

export function getPaneDrag() {
  return current
}

export function subscribePaneDrag(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试与「拖拽被浏览器中断」场景的硬复位 */
export function resetPaneDrag() {
  current = null
  emit()
}

export function isPaneDrag(dataTransfer?: DataTransfer | null) {
  if (current) return true
  return !!dataTransfer?.types?.includes(PANE_DRAG_MIME)
}

/**
 * drop 阶段解析源 pane：dataTransfer 优先（跨 iframe/同页都可靠），
 * 单例兜底（部分浏览器在 dragover/drop 之间丢 payload）。
 */
export function readPaneDragPayload(dataTransfer?: DataTransfer | null): PaneDragPayload | null {
  const raw = dataTransfer?.getData?.(PANE_DRAG_MIME) || ''
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PaneDragPayload>
      if (parsed && typeof parsed.paneId === 'string' && parsed.paneId) {
        return {
          paneId: parsed.paneId,
          windowId: typeof parsed.windowId === 'string' ? parsed.windowId : undefined,
          title: typeof parsed.title === 'string' ? parsed.title : undefined,
        }
      }
    } catch {
      // 老客户端/手写 payload 可能不是 JSON：按裸 paneId 处理
      return { paneId: raw }
    }
  }
  return current
}

/**
 * 指针落在矩形哪一侧：比较「离水平中线的距离」和「离垂直中线的距离」，
 * 偏离哪个中线更远就按那个轴切（拖到右半边 → 右侧插入，拖到上沿 → 上方插入）。
 * 正中线/四角这类平局归水平——tmux 里左右分是最常用的手势。
 */
export function resolvePaneDropSide(rect: PaneDropRect, x: number, y: number): PaneDropSide {
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const nx = Math.min(1, Math.max(0, (x - rect.left) / width))
  const ny = Math.min(1, Math.max(0, (y - rect.top) / height))
  const horizontalBias = Math.abs(nx - 0.5)
  const verticalBias = Math.abs(ny - 0.5)
  if (horizontalBias >= verticalBias) return nx < 0.5 ? 'left' : 'right'
  return ny < 0.5 ? 'top' : 'bottom'
}

/** 契约里 direction 只有两档：左右=horizontal，上下=vertical */
export function directionForPaneDropSide(side: PaneDropSide): PaneMoveDirection {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical'
}

/**
 * 把 window 内所有 pane 的 tmux 像素几何归一化成 0..1 的落点矩形。
 * 几何缺失（老网关/单 pane）时返回空数组：没有可靠落点就不画覆盖层，
 * 用户仍可拖到窗口标签上（那条路径不依赖几何）。
 */
export function buildPaneDropRegions(
  panes: Array<{
    id: string
    title?: string
    index?: number
    left?: number
    top?: number
    size?: { cols?: number; rows?: number }
  }>,
): PaneDropRegion[] {
  if (!Array.isArray(panes) || panes.length === 0) return []
  const cols = Math.max(...panes.map((pane) => (pane.left || 0) + (pane.size?.cols || 0)))
  const rows = Math.max(...panes.map((pane) => (pane.top || 0) + (pane.size?.rows || 0)))
  if (!cols || !rows) return []
  return panes
    .filter((pane) => !!pane.size?.cols && !!pane.size?.rows)
    .map((pane) => ({
      paneId: pane.id,
      title: pane.title || `#${(pane.index ?? 0) + 1}`,
      index: pane.index ?? 0,
      rect: {
        left: (pane.left || 0) / cols,
        top: (pane.top || 0) / rows,
        width: (pane.size?.cols || 0) / cols,
        height: (pane.size?.rows || 0) / rows,
      },
    }))
}
