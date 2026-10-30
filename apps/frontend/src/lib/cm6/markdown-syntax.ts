// Markdown live preview 的「源码区间」扫描层：把 lezer 语法树映射成运行期要隐藏/替换的字符区间。
//
// 设计要点：
// - 源码即真相：这里只描述标记字符的区间，不产出任何 DOM，便于单测与调试；
// - 不变量：每个 range 都满足 text.slice(from, to) 恰好是原文中的那串标记（单测按此断言）；
// - 容器节点（强调/链接/图片/围栏/任务）只看直接子标记，避免父子重复产出：
//   `***x***` 里 Emphasis 与 StrongEmphasis 各持一对 EmphasisMark，各管各的才不会重复 hide；
// - 只处理单行结构：replace 装饰不能跨行，块级（围栏/表格）只产出 MdBlock 交给行样式；
// - 未覆盖的语法（setext 标题、引用式链接、有序列表编号、缩进代码块）一律保留源码，
//   宁可不好看也不要藏掉用户看不懂的字符。
import { GFM, parser as markdownParser } from '@lezer/markdown'

export type MdRangeKind =
  | 'heading-marker'
  | 'strong'
  | 'emphasis'
  | 'inline-code'
  | 'strikethrough'
  | 'link'
  | 'image'
  | 'bullet'
  | 'quote'
  | 'task'
  | 'code-fence-info'

export interface MdRange {
  from: number
  to: number
  kind: MdRangeKind
  // heading-marker：1-6 级，供装饰层选字号
  level?: number
  // image：alt 原文；code-fence-info：info 串原文
  text?: string
  // link/image：目标地址原文
  url?: string
  // task：是否已勾选
  checked?: boolean
}

export type MdBlockKind = 'fenced-code' | 'table'

export interface MdBlock {
  kind: MdBlockKind
  from: number
  to: number
  // fenced-code 的语言（info 串首个 token，无语言时为空串）
  lang?: string
}

export type MdStyleKind = 'strong' | 'emphasis' | 'strikethrough' | 'inline-code' | 'link'

// 标记之间需要加样式的正文区间（加粗/斜体/等宽/链接色）。
// 单独存在的原因：MdRange 表达的是「藏什么」，样式表达的是「留什么怎么显示」，
// 二者在参数/嵌套上是不同维度，混在一起会让 decorations 再做一遍配对推断。
export interface MdStyleSpan {
  from: number
  to: number
  kind: MdStyleKind
}

export interface MdScan {
  ranges: MdRange[]
  blocks: MdBlock[]
  styles: MdStyleSpan[]
}

// 只依赖语法树的最小结构，不 import @lezer/common：
// 该包是 @lezer/markdown 的传递依赖，未在 package.json 声明，直接引用会在 pnpm 严格布局下变成隐患。
export interface MdTreeNode {
  name: string
  from: number
  to: number
  firstChild: MdTreeNode | null
  nextSibling: MdTreeNode | null
}

const PARSER = markdownParser.configure(GFM)
const ATX_HEADING = /^ATXHeading([1-6])$/
const BULLET_MARK = /^[-*+]$/

// 取直接子节点里的同名节点（不递归：嵌套结构由各自的容器负责）
function childrenNamed(node: MdTreeNode, name: string): MdTreeNode[] {
  const found: MdTreeNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) found.push(child)
  }
  return found
}

// 标记后紧随的空格/制表符：`# `、`- `、`> ` 的尾随空白也要一起藏掉，否则渲染态会多出缩进。
// 越界时 slice 返回空串 → 自然停在行尾，不需要显式的行边界参数。
function skipBlanks(slice: (from: number, to: number) => string, from: number): number {
  let pos = from
  while (slice(pos, pos + 1) === ' ' || slice(pos, pos + 1) === '\t') pos += 1
  return pos
}

function scanHeading(node: MdTreeNode, level: number, slice: Slice, out: MdScan) {
  // 收尾的 ### 也是 HeaderMark：一起藏掉，标题才和渲染态一致
  for (const mark of childrenNamed(node, 'HeaderMark')) {
    out.ranges.push({ from: mark.from, to: skipBlanks(slice, mark.to), kind: 'heading-marker', level })
  }
}

function scanInline(node: MdTreeNode, markName: string, kind: MdStyleKind, slice: Slice, out: MdScan) {
  const marks = childrenNamed(node, markName)
  if (marks.length < 2) return // 未闭合的标记不产生区间，源码原样保留
  for (const mark of marks) out.ranges.push({ from: mark.from, to: mark.to, kind })
  const from = marks[0].to
  const to = marks[marks.length - 1].from
  if (to > from) out.styles.push({ from, to, kind })
}

function scanInlineCode(node: MdTreeNode, out: MdScan) {
  const marks = childrenNamed(node, 'CodeMark')
  if (marks.length < 2) return
  for (const mark of marks) out.ranges.push({ from: mark.from, to: mark.to, kind: 'inline-code' })
  const from = marks[0].to
  const to = marks[marks.length - 1].from
  if (to > from) out.styles.push({ from, to, kind: 'inline-code' })
}

function scanLink(node: MdTreeNode, slice: Slice, out: MdScan) {
  const marks = childrenNamed(node, 'LinkMark')
  const target = childrenNamed(node, 'URL')[0]
  // 引用式链接（[text][ref]）没有 URL：整段保留源码，避免把 [ref] 藏成看不见的引用
  if (!target || marks.length < 4) return
  const [open, close, paren, end] = marks
  const url = slice(target.from, target.to)
  const text = slice(open.to, close.from)
  out.ranges.push(
    { from: open.from, to: open.to, kind: 'link', url, text },
    { from: close.from, to: paren.to, kind: 'link', url }, // "](" 作为一个整体藏
    { from: target.from, to: target.to, kind: 'link', url },
    { from: end.from, to: end.to, kind: 'link', url },
  )
  const title = childrenNamed(node, 'LinkTitle')[0]
  // 标题串（"t"）连同前面的空白一起藏，否则会残留一对引号
  if (title) out.ranges.push({ from: target.to, to: title.to, kind: 'link', url })
  if (close.from > open.to) out.styles.push({ from: open.to, to: close.from, kind: 'link' })
}

function scanAutolink(node: MdTreeNode, slice: Slice, out: MdScan) {
  const marks = childrenNamed(node, 'LinkMark')
  const target = childrenNamed(node, 'URL')[0]
  if (!target || marks.length < 2) return
  const url = slice(target.from, target.to)
  // <url> 只藏尖括号，URL 本身按链接样式显示
  out.ranges.push(
    { from: marks[0].from, to: marks[0].to, kind: 'link', url },
    { from: marks[marks.length - 1].from, to: marks[marks.length - 1].to, kind: 'link', url },
  )
  out.styles.push({ from: target.from, to: target.to, kind: 'link' })
}

function scanImage(node: MdTreeNode, slice: Slice, out: MdScan) {
  const marks = childrenNamed(node, 'LinkMark')
  const target = childrenNamed(node, 'URL')[0]
  if (!target || marks.length < 2) return
  out.ranges.push({
    from: node.from,
    to: node.to,
    kind: 'image',
    text: slice(marks[0].to, marks[1].from),
    url: slice(target.from, target.to),
  })
}

function scanFence(node: MdTreeNode, slice: Slice, out: MdScan) {
  const info = childrenNamed(node, 'CodeInfo')[0]
  const text = info ? slice(info.from, info.to) : ''
  out.blocks.push({ kind: 'fenced-code', from: node.from, to: node.to, lang: text.split(/\s+/)[0] || '' })
  // info 串不藏：围栏源码行整体保留，只把它染色成语言标签
  if (info) out.ranges.push({ from: info.from, to: info.to, kind: 'code-fence-info', text })
}

function scanListItem(node: MdTreeNode, slice: Slice, out: MdScan) {
  const mark = childrenNamed(node, 'ListMark')[0]
  if (!mark) return
  // 有序列表（1. / 1)）保留编号：藏了就没有层级参照，本轮也不做自动编号
  if (!BULLET_MARK.test(slice(mark.from, mark.to))) return
  out.ranges.push({ from: mark.from, to: skipBlanks(slice, mark.to), kind: 'bullet' })
}

function scanTask(node: MdTreeNode, slice: Slice, out: MdScan) {
  const marker = childrenNamed(node, 'TaskMarker')[0]
  if (!marker) return
  out.ranges.push({
    from: marker.from,
    to: marker.to,
    kind: 'task',
    checked: /^\[[xX]\]$/.test(slice(marker.from, marker.to)),
  })
}

type Slice = (from: number, to: number) => string

// 单节点分派。CM6 的语法树和单独 parse 的树节点名一致，装饰层可直接复用本函数。
export function collectMarkdownScan(node: MdTreeNode, slice: Slice, out: MdScan): void {
  const heading = ATX_HEADING.exec(node.name)
  if (heading) return scanHeading(node, Number(heading[1]), slice, out)
  switch (node.name) {
    case 'StrongEmphasis':
      return scanInline(node, 'EmphasisMark', 'strong', slice, out)
    case 'Emphasis':
      return scanInline(node, 'EmphasisMark', 'emphasis', slice, out)
    case 'Strikethrough':
      return scanInline(node, 'StrikethroughMark', 'strikethrough', slice, out)
    case 'InlineCode':
      return scanInlineCode(node, out)
    case 'Link':
      return scanLink(node, slice, out)
    case 'Autolink':
      return scanAutolink(node, slice, out)
    case 'Image':
      return scanImage(node, slice, out)
    case 'FencedCode':
      return scanFence(node, slice, out)
    case 'Table':
      // 表格本轮不做 widget：只给行样式（等宽），源码照旧可编辑
      out.blocks.push({ kind: 'table', from: node.from, to: node.to })
      return
    case 'ListItem':
      return scanListItem(node, slice, out)
    case 'Task':
      return scanTask(node, slice, out)
    case 'QuoteMark':
      // 嵌套引用 `> > x` 的每个 QuoteMark 都是独立节点，逐个藏到空格为止
      out.ranges.push({ from: node.from, to: skipBlanks(slice, node.to), kind: 'quote' })
      return
    default:
      return
  }
}

export function scanMarkdown(text: string): MdScan {
  const slice: Slice = (from, to) => text.slice(from, to)
  const out: MdScan = { ranges: [], blocks: [], styles: [] }
  PARSER.parse(text).iterate({ enter: (ref) => collectMarkdownScan(ref.node, slice, out) })
  return sortScan(out)
}

export function scanMarkdownRanges(text: string): MdRange[] {
  return scanMarkdown(text).ranges
}

// 装饰层要求有序区间；扫描按树先序本身就是升序，这里再排一次以防未来改动打乱顺序
export function sortScan(scan: MdScan): MdScan {
  scan.ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  scan.blocks.sort((a, b) => a.from - b.from || a.to - b.to)
  scan.styles.sort((a, b) => a.from - b.from || a.to - b.to)
  return scan
}
