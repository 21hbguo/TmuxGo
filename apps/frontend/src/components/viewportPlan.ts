// 布局计划纯函数：把现有产品策略（fit / 键盘底锚裁剪 / 共享跟随）形式化成一次
// 决策输出。只消费 viewportContract 的类型与几何数值：不读 DOM、不读 body class、
// 不注册定时器；落盘执行（xterm resize、CSS transform、dock 显隐）交给唯一写入端。
// 因此同一输入永远得到同一 LayoutPlan，可直接用于重放与影子运行。
import type { LayoutPlan, ViewportSnapshot } from './viewportContract'

export type LayoutOwnership = 'exclusive' | 'shared'
export type LayoutRemainderFill = 'background' | 'last-row'

export type LayoutPlanInput = {
  snapshot: ViewportSnapshot
  // 终端 pane 的容器像素几何（可能仍是尚未跟上遮挡的旧值）
  pane: { width: number; height: number }
  cell: { width: number; height: number }
  currentGrid: { cols: number; rows: number }
  ownership: LayoutOwnership
  dockHeight: number
  version: number
  // 渲染端采样的滚动位置是否仍在底部。缺省 true = 现状（移动端未回滚即贴底）：
  // 翻看历史的用户不能被键盘/网格变化拽回底部
  scrollAtBottom?: boolean
  // 余量填充策略；缺省按余量大小推断，见 computeLayoutPlan 内注释
  remainderFill?: LayoutRemainderFill
}

// 与 terminal-layout 的 fit 保底一致：至少 2 列 1 行，避免 0 尺寸网格下发
const MIN_COLS = 2
const MIN_ROWS = 1

// 几何输入来自 DOM 采样，NaN/负值不能扩散成 NaN 网格
const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0)

function fitGrid(
  width: number,
  height: number,
  cell: { width: number; height: number },
): { cols: number; rows: number } | null {
  const cellWidth = positive(cell.width)
  const cellHeight = positive(cell.height)
  if (!cellWidth || !cellHeight) return null
  return {
    cols: Math.max(MIN_COLS, Math.floor(positive(width) / cellWidth)),
    rows: Math.max(MIN_ROWS, Math.floor(positive(height) / cellHeight)),
  }
}

export function computeLayoutPlan(input: LayoutPlanInput): LayoutPlan {
  const { snapshot, pane, cell, currentGrid, ownership, dockHeight, version } = input
  // shell 高度直接取可见区域：遮挡已由 normalize 扣过，plan 不再扣第二次
  // （同一遮挡一帧只扣一次）
  const shellHeight = positive(snapshot.visibleRegion.height)
  // 终端最多占到可见区域高：pane 容器可能还没跟上遮挡（RO 晚一帧），取 min
  // 让裁剪先顶住，而不是相信陈旧的容器高度
  const visibleHeight = Math.min(positive(pane.height), shellHeight)
  // 遮挡带高度：source='none' 表示没有遮挡来源，此时 height 只是参考值
  // （inferred 来源可被后续观测修正）
  const occludedHeight = snapshot.occlusion.source === 'none' ? 0 : positive(snapshot.occlusion.height)
  const cellHeight = positive(cell.height)
  const fit = fitGrid(pane.width, visibleHeight, cell)
  const gridChanged = fit != null && (fit.cols !== currentGrid.cols || fit.rows !== currentGrid.rows)
  // 纯高度遮挡：列数不变、行数变少、且确有遮挡来源。此时必须保住网格——
  // refit 会把最后可见行挤出裁剪窗口（prompt 行下跳/被裁），改由 clipTranslateY
  // 底锚裁剪把 canvas 上移，使最后一行留在底边
  const occlusionOnly =
    fit != null && occludedHeight > 0 && fit.cols === currentGrid.cols && fit.rows < currentGrid.rows
  // 共享端服从远端协议尺寸：本地网格由 sharedSize 决定，永不本地 refit、也永不
  // 申请远端 resize；独占端的真网格变化（宽度/字体/分屏/高度增长）才重算。
  // 可见区为 0（应用不可见/几何缺失）时禁止 refit：否则 floor(0/cell) 会把远端
  // 窗口缩成 1 行，这种退化状态只允许裁剪，等观测恢复后再重算
  const canRefit = fit != null && visibleHeight > 0 && cellHeight > 0
  const targetGrid: LayoutPlan['terminal']['targetGrid'] =
    canRefit && ownership === 'exclusive' && gridChanged && !occlusionOnly ? { cols: fit.cols, rows: fit.rows } : 'keep'
  const plannedRows = targetGrid === 'keep' ? currentGrid.rows : targetGrid.rows
  const canvasHeight = positive(plannedRows) * cellHeight
  // 底锚裁剪量：画布高超出可见高的部分整体上移，最后一行贴底。上界夹到画布高
  // ——可见高为 0 时最多上移一整幅，不产生负行外露；refit 正常情况下画布不超高，
  // 自然得 0（只有可见高不足一行时才有残差）
  const clipTranslateY = cellHeight > 0 ? Math.max(0, Math.min(canvasHeight, canvasHeight - visibleHeight)) : 0
  const leftover = Math.max(0, visibleHeight - canvasHeight)
  // 余量填充：不足一行的残差是 floor 的必然产物，沿用现状把最后一行拉高铺满；
  // 整行及以上的空白不是残差（keep 时网格可能比可用高度少一整行），拉高最后
  // 一行会得到一条畸形巨行，改为背景填充。显式传入策略时以传入值为准
  const remainderFill: LayoutPlan['terminal']['remainderFill'] =
    input.remainderFill ?? (cellHeight > 0 && leftover >= cellHeight ? 'background' : 'last-row')
  // dock 与遮挡带都底锚在布局空间：dock 占底部 dockHeight，遮挡带从底向上
  // occludedHeight。两者相交 ⇔ 有遮挡且有 dock 高度——此时 dock 只能隐藏或上推，
  // 不能压缩（压缩会改 shell 高度，反过来污染基线）
  const dockCovered = positive(dockHeight) > 0 && occludedHeight > 0
  return {
    version,
    shell: { height: shellHeight },
    dock: dockCovered ? 'covered' : 'visible',
    terminal: {
      visibleHeight,
      targetGrid,
      clipTranslateY,
      remainderFill,
      scrollAnchor: input.scrollAtBottom === false ? 'keep' : 'bottom',
    },
    requestRemoteResize: targetGrid === 'keep' ? null : { cols: targetGrid.cols, rows: targetGrid.rows },
  }
}
