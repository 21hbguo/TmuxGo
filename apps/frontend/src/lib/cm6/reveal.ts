// 光标/选区决定哪些标记要展开：隐藏是「默认态」，只有正在编辑的行才回到源码态。
//
// 规则与 Obsidian 一致：
// - 光标所在行整行展开（`# `、`**`、`[ ]` 全部可见，便于直接改源码）；
// - 非空选区与某行相交，则该行展开（框选多行时逐行展开）；
// - 多选时任一选区相交即展开。
// 刻意不做 atomicRanges / uneditable 隐藏区间：光标要能自由穿过标记，否则方向键会跳格。
export interface OffsetRange {
  from: number
  to: number
}

export function shouldRevealLine(lineFrom: number, lineTo: number, selection: OffsetRange): boolean {
  if (selection.from === selection.to) {
    // 光标：lineTo 是行尾换行前的位置，落在 [lineFrom, lineTo] 都属于本行
    return selection.from >= lineFrom && selection.from <= lineTo
  }
  // 选区：闭区间相交（首尾相接也算，行尾继续下移时光标所在的下一行要及时展开）
  return selection.from <= lineTo && selection.to >= lineFrom
}

export function isRangeRevealed(range: OffsetRange, selection: OffsetRange, lineFrom: number, lineTo: number): boolean {
  if (shouldRevealLine(lineFrom, lineTo, selection)) return true
  // 兜底：标记整段落在选区内（行边界裁剪导致行级判断为假时仍应展开）
  return selection.from <= range.from && range.to <= selection.to
}
