// 遮挡成因的跨模块事实源。
//
// 时序不变量：ResizeObserver 观察到的容器变化，其遮挡成因必须已可读。
// model 模式下壳高随 visibleRegion 一缩就改（V7 接管），旧执行器 terminal-layout
// 仍要判断「这次变化是不是纯遮挡（保网格 + 底锚裁剪）」。判断依据若是
// body.keyboard-open，会因 useMobileKeyboard 的独立推断晚于容器变化而落空，
// 终端就把遮挡当普通 resize：refit + onResize 下发远端尺寸主张，后到的 class
// 收不回来（2026-10-25 v7_early_shell_resize 事故）。
//
// 因此 ConsoleLayout 在改壳高、dispatch layout-change 之前同步写
// body[data-viewport-occlusion]；RO 回调时该属性必定已就位。
// legacy 模式不写（保持现状语义），消费端对两者取「或」：任一成立即按遮挡处理。
// 方向是保守的——误判成遮挡只会多做一次裁剪，反向误判会改远端窗口。
export const VIEWPORT_OCCLUSION_ATTR = 'data-viewport-occlusion'

// 唯一写入端：null/0/非正数 = 无遮挡，删属性而不是写 0，避免陈旧成因压住后续判定
export function writeViewportOcclusion(height: number | null, body: HTMLElement = document.body): void {
  if (height == null || !Number.isFinite(height) || height <= 0) {
    if (body.hasAttribute(VIEWPORT_OCCLUSION_ATTR)) body.removeAttribute(VIEWPORT_OCCLUSION_ATTR)
    return
  }
  const next = String(Math.round(height))
  if (body.getAttribute(VIEWPORT_OCCLUSION_ATTR) !== next) body.setAttribute(VIEWPORT_OCCLUSION_ATTR, next)
}

// 读成因高度：正整数 = model 模式的同步权威值；0 = 属性缺省（legacy 路径）
export function readViewportOcclusion(body: HTMLElement = document.body): number {
  const raw = body.getAttribute(VIEWPORT_OCCLUSION_ATTR)
  if (raw === null) return 0
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

// 消费端判定：model 属性（权威、同 turn）或 legacy body class，任一成立即为遮挡
export const hasViewportOcclusion = (body: HTMLElement = document.body): boolean =>
  readViewportOcclusion(body) > 0 || body.classList.contains('keyboard-open')
