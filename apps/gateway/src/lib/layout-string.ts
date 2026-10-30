// tmux 原生 layout string（`#{window_layout}`）的纯逻辑层：校验、叶子数、根尺寸。
//
// 语法来自 tmux layout_dump（`tmux list-windows -F '#{window_layout}'`）：
//   <4 位十六进制校验和>,<WxH>,<x>,<y>({…}|[…]|)
//   cell   = <WxH>,<x>,<y>[,<paneIndex>]        ← 叶子（正好一个 pane）
//          | <WxH>,<x>,<y>{<cell>,<cell>,…}     ← 左右分割（left/right）
//          | <WxH>,<x>,<y>[<cell>,<cell>,…]     ← 上下分割（top/bottom）
// 两种括号是 tmux 的语义标记而非装饰：`{}` = 横向并排、`[]` = 竖向堆叠（tmux 3.4 实测
// `0ed4,120x30,0,0[120x24,0,0,3,120x5,0,25,0]` 就是上下两栏），且可以任意混用嵌套。
// 例：709c,120x30,0,0{60x30,0,0,0,59x30,61,0,2}
// 叶子的 paneIndex 是**可选**的：老版本/手写布局只有 4 个数字，现代 tmux 会多带一位
// pane 序号，所以解析按「数字后跟 , 且下一个 token 不以 'x' 形态出现」来区分
// 「pane 序号」与「下一个兄弟 cell」。
//
// 这里只做字符串层面的判定，不碰 tmux：路由层负责取串/套用，本模块可单测。

export const LAYOUT_STRING_MIN_LENGTH = 16
export const LAYOUT_STRING_MAX_LENGTH = 4096
// tmux layout string 只会出现十六进制校验和、小写 x、花括号、逗号和数字；
// 白名单收窄比黑名单稳（顺带挡住空白、引号、换行等注入面）
const LAYOUT_CHARSET = /^[0-9a-fx{}[\],]+$/
const CHECKSUM = /^[0-9a-f]{4},/
// 单个维度/坐标的合理上限：正常终端不会到 6 位数，超了基本是垃圾输入
const MAX_DIMENSION = 100_000

export type LayoutStringErrorCode = 'LAYOUT_INVALID' | 'LAYOUT_PANE_MISMATCH'

// 带稳定 code 的领域错误：路由层按 code 映射 HTTP 状态，不乱抛
export class LayoutStringError extends Error {
  readonly code: LayoutStringErrorCode
  constructor(code: LayoutStringErrorCode, message: string) {
    super(message)
    this.name = 'LayoutStringError'
    this.code = code
  }
}

export interface LayoutDimensions {
  cols: number
  rows: number
}

export interface ParsedLayoutString {
  checksum: string
  dimensions: LayoutDimensions
  panes: number
}

function invalid(reason: string): never {
  throw new LayoutStringError('LAYOUT_INVALID', `Invalid layout string: ${reason}`)
}

// 读一串十进制数字；工位越界/空串都算非法
function readNumber(src: string, cursor: number, field: string) {
  let end = cursor
  while (end < src.length && src[end] >= '0' && src[end] <= '9') end++
  if (end === cursor) invalid(`missing ${field} at offset ${cursor}`)
  const value = Number(src.slice(cursor, end))
  if (!Number.isSafeInteger(value) || value > MAX_DIMENSION) invalid(`${field} out of range at offset ${cursor}`)
  return { value, next: end }
}

function expectChar(src: string, cursor: number, char: string) {
  if (src[cursor] !== char) invalid(`expected "${char}" at offset ${cursor}`)
  return cursor + 1
}

interface CellParseResult {
  panes: number
  next: number
}

// 递归下降解析一个 cell；返回它的叶子数与消费到的下标
function parseCell(src: string, cursor: number): CellParseResult {
  const size = readNumber(src, cursor, 'width')
  cursor = expectChar(src, size.next, 'x')
  const height = readNumber(src, cursor, 'height')
  cursor = expectChar(src, height.next, ',')
  const xoff = readNumber(src, cursor, 'x offset')
  cursor = expectChar(src, xoff.next, ',')
  const yoff = readNumber(src, cursor, 'y offset')
  cursor = yoff.next
  const opener = src[cursor]
  if (opener === '{' || opener === '[') {
    // 分割节点：`{child,child,…}`（左右）或 `[child,child,…]`（上下）。
    // 括号必须按类型配对，但内层可以随便换：横向里的某一栏再上下切就是 {…[…]}。
    const closer = opener === '{' ? '}' : ']'
    cursor++
    let panes = 0
    let children = 0
    for (;;) {
      const child = parseCell(src, cursor)
      panes += child.panes
      children++
      cursor = child.next
      if (src[cursor] === ',') {
        cursor++
        continue
      }
      break
    }
    if (children < 2) invalid('split node must hold at least two cells')
    if (src[cursor] !== closer) invalid(`expected "${closer}" at offset ${cursor}`)
    return { panes, next: cursor + 1 }
  }
  // 叶子：可选 pane 序号（老格式没有）。仅当后面紧跟纯数字 token 且其后是分隔符时才算序号，
  // 否则把它留给上层当兄弟 cell 的开头（兄弟 cell 的 width 后面一定跟 'x'）。
  if (src[cursor] === ',') {
    let probe = cursor + 1
    while (probe < src.length && src[probe] >= '0' && src[probe] <= '9') probe++
    // 序号后面可能紧跟兄弟分隔符、任一收尾括号，或者到头（单 pane 窗口）
    const terminator = src[probe]
    const looksLikePaneIndex =
      probe > cursor + 1 && (terminator === ',' || terminator === '}' || terminator === ']' || probe >= src.length)
    if (looksLikePaneIndex) cursor = probe
  }
  return { panes: 1, next: cursor }
}

function parseLayout(input: unknown): ParsedLayoutString {
  if (typeof input !== 'string') invalid('layout must be a string')
  const layout = input.trim()
  if (!layout) invalid('layout is empty')
  if (layout.length < LAYOUT_STRING_MIN_LENGTH) invalid(`layout is shorter than ${LAYOUT_STRING_MIN_LENGTH} chars`)
  if (layout.length > LAYOUT_STRING_MAX_LENGTH) invalid(`layout is longer than ${LAYOUT_STRING_MAX_LENGTH} chars`)
  if (!LAYOUT_CHARSET.test(layout)) invalid('layout contains characters outside [0-9a-fx{},[]]')
  const checksumMatch = CHECKSUM.exec(layout)
  if (!checksumMatch) invalid('layout must start with a 4-digit hex checksum followed by ","')
  const root = parseCell(layout, checksumMatch[0].length)
  if (root.next !== layout.length) invalid(`trailing data at offset ${root.next}`)
  const dimensions = readRootDimensions(layout)
  return { checksum: checksumMatch[0].slice(0, 4), dimensions, panes: root.panes }
}

// 根 cell 的 WxH 就是整个窗口的尺寸；单独抽出来给 layoutDimensions 复用
function readRootDimensions(layout: string) {
  const start = layout.indexOf(',') + 1
  const width = readNumber(layout, start, 'width')
  const afterX = expectChar(layout, width.next, 'x')
  const height = readNumber(layout, afterX, 'height')
  return { cols: width.value, rows: height.value }
}

// 校验并返回结构化结果；非法输入抛 LayoutStringError('LAYOUT_INVALID')
export function validateLayoutString(input: unknown): ParsedLayoutString {
  return parseLayout(input)
}

// 布局树里的叶子（pane）数量
export function countLayoutPanes(input: string): number {
  return parseLayout(input).panes
}

// 根 cell 尺寸：`709c,120x30,…` → { cols: 120, rows: 30 }
export function layoutDimensions(input: string): LayoutDimensions {
  return parseLayout(input).dimensions
}

// 把「布局需要的 pane 数」与目标窗口实际 pane 数对齐；不一致抛
// LayoutStringError('LAYOUT_PANE_MISMATCH')，文案沿用 tmux 原文便于对照
export function assertLayoutPaneCount(layout: string, actualPanes: number): number {
  const required = parseLayout(layout).panes
  if (required !== actualPanes)
    throw new LayoutStringError('LAYOUT_PANE_MISMATCH', `have ${actualPanes} panes but need ${required}`)
  return required
}
