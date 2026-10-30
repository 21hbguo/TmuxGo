// 把扫描结果变成 CM6 装饰集。
//
// 结构：
// - 行装饰（Decoration.line）：标题字号、引用左边线、围栏/表格底色 —— 只描述「整行长什么样」；
// - 替换装饰（Decoration.replace）：藏掉标记，图片/复选框换成 widget；
// - 标记装饰（Decoration.mark）：标记之间的正文加粗/斜体/等宽/链接色。
//
// 为什么整块装饰集由 StateField 提供：CM6 只允许 StateField 提供影响块结构（行高/块 widget）的装饰，
// ViewPlugin 提供的装饰被限制在行内。这里图片/复选框都可能是块级内容，统一走 StateField 最稳。
//
// 重算策略：文档变化或语法树推进时整块重算；选区变化只在「展开行集合」变了时才重算；
// 语法树用 CM6 自己维护的 syntaxTree（同一份 markdown 语言扩展），不重复 parse 全文。
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { collectMarkdownScan, sortScan, type MdBlock, type MdScan } from './markdown-syntax'
import { isRangeRevealed } from './reveal'

export interface MarkdownDecorationHost {
  // 解析图片地址：path 为 root 相对路径（外部地址传 null）
  loadImage?: (src: string, path: string | null) => Promise<string | null>
  openExternal?: (href: string) => void
}

const IMAGE_LOADING = '图片加载中…'
const IMAGE_MISSING = '图片不可用'
const IMAGE_CACHE_LIMIT = 64
const REMOTE_URL = /^https?:\/\//i
// 解析结果缓存：装饰集每次按键重建，没缓存会导致每敲一个字图片就重新请求一次
const imageCache = new Map<string, string | null>()

function rememberImage(url: string, resolved: string | null) {
  // 简单容量上限即可：清空重来比 LRU 更不容易出错，图片缓存的命中只影响体验
  if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.clear()
  imageCache.set(url, resolved)
}

// 外部地址（http/https/data/blob/协议相对）不交给调用方解析，直接交给浏览器/调用方；
// 其余按仓库内相对路径处理（去掉 ./ 前缀，root 相对由调用方自己的文档目录决定）
export function imagePathOf(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed)) return null
  return trimmed.replace(/^\.\//, '')
}

function resolveImage(url: string, host: MarkdownDecorationHost): Promise<string | null> {
  const cached = imageCache.get(url)
  if (cached !== undefined) return Promise.resolve(cached)
  const loader = host.loadImage
  if (!loader) {
    // 没有解析器时不阻塞渲染：把原始 src 交给 <img>，data/http 地址仍然能显示
    rememberImage(url, url)
    return Promise.resolve(url)
  }
  return Promise.resolve()
    .then(() => loader(url, imagePathOf(url)))
    .then((resolved) => {
      const value = resolved || null
      rememberImage(url, value)
      return value
    })
    .catch(() => {
      // 失败也缓存：坏地址不该在每次重绘时重试
      rememberImage(url, null)
      return null
    })
}

class BulletWidget extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof BulletWidget
  }

  toDOM() {
    const dot = document.createElement('span')
    dot.className = 'cm-md-bullet'
    dot.textContent = '•'
    return dot
  }

  ignoreEvent() {
    return true
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super()
  }

  eq(other: WidgetType) {
    return (
      other instanceof CheckboxWidget &&
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    )
  }

  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-md-checkbox'
    // 不抢焦点：mousedown 的默认行为会移动选区，行会因此展开，复选框闪一下又变回源码
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      event.preventDefault()
      // 只读文档不该被点改：读屏器/键盘也能触发 click，这里必须自己拦
      if (view.state.readOnly) return
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
        userEvent: 'input.md-task',
      })
    })
    return box
  }

  ignoreEvent() {
    return true
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly host: MarkdownDecorationHost,
  ) {
    super()
  }

  // 地址/替代文本不变就复用 DOM：光标在别处打字时不该重建图片节点
  eq(other: WidgetType) {
    return other instanceof ImageWidget && other.url === this.url && other.alt === this.alt
  }

  toDOM() {
    const box = document.createElement('span')
    box.className = 'cm-md-image'
    box.setAttribute('data-md-src', this.url)
    box.textContent = this.alt || IMAGE_LOADING
    const showFallback = () => {
      box.classList.add('cm-md-image-missing')
      box.textContent = this.alt || IMAGE_MISSING
    }
    void resolveImage(this.url, this.host).then((resolved) => {
      if (!resolved) {
        showFallback()
        return
      }
      const img = document.createElement('img')
      img.className = 'cm-md-image-el'
      img.alt = this.alt
      img.src = resolved
      img.addEventListener('error', showFallback)
      box.replaceChildren(img)
    })
    box.addEventListener('click', () => {
      if (REMOTE_URL.test(this.url)) this.host.openExternal?.(this.url)
    })
    return box
  }

  ignoreEvent() {
    return true
  }
}

function addLineClass(lines: Map<number, string[]>, position: number, className: string) {
  const existing = lines.get(position)
  if (!existing) lines.set(position, [className])
  else if (!existing.includes(className)) existing.push(className)
}

function forEachLine(state: EditorState, block: MdBlock, visit: (from: number) => void) {
  const doc = state.doc
  let line = doc.lineAt(Math.min(block.from, doc.length))
  for (;;) {
    visit(line.from)
    if (line.to >= block.to || line.number >= doc.lines) return
    line = doc.line(line.number + 1)
  }
}

const MARK_CLASS: Record<string, string> = {
  strong: 'cm-md-strong',
  emphasis: 'cm-md-emphasis',
  strikethrough: 'cm-md-strike',
  'inline-code': 'cm-md-code',
  link: 'cm-md-link',
}

export function buildMarkdownDecorations(state: EditorState, host: MarkdownDecorationHost): DecorationSet {
  const doc = state.doc
  const scan: MdScan = { ranges: [], blocks: [], styles: [] }
  const slice = (from: number, to: number) => doc.sliceString(from, to)
  syntaxTree(state).iterate({ enter: (ref) => collectMarkdownScan(ref.node, slice, scan) })
  sortScan(scan)

  const decorations: Range<Decoration>[] = []
  const lineClasses = new Map<number, string[]>()

  const revealed = (from: number, to: number) => {
    const line = doc.lineAt(from)
    return state.selection.ranges.some((range) => isRangeRevealed({ from, to }, range, line.from, line.to))
  }
  const hide = (from: number, to: number) => {
    if (to > from) decorations.push(Decoration.replace({}).range(from, to))
  }

  // 任务行的列表符号让位给复选框（`- [ ]` 只留一个可点的方框）
  const taskLines = new Set<number>()
  for (const range of scan.ranges) {
    if (range.kind === 'task') taskLines.add(doc.lineAt(range.from).from)
  }

  for (const block of scan.blocks) {
    // 围栏源码保留，只加底色；语言标签由 info 串的 .cm-md-fence-lang 染色，不再重复渲染一次
    forEachLine(state, block, (from) => {
      addLineClass(lineClasses, from, block.kind === 'table' ? 'cm-md-table' : 'cm-md-codeblock')
    })
  }

  for (const style of scan.styles) {
    const className = MARK_CLASS[style.kind]
    if (className && style.to > style.from) {
      decorations.push(Decoration.mark({ class: className }).range(style.from, style.to))
    }
  }

  for (const range of scan.ranges) {
    switch (range.kind) {
      case 'heading-marker':
        addLineClass(lineClasses, range.from, 'cm-md-heading')
        addLineClass(lineClasses, range.from, `cm-md-h${range.level ?? 1}`)
        if (!revealed(range.from, range.to)) hide(range.from, range.to)
        break
      case 'quote':
        addLineClass(lineClasses, range.from, 'cm-md-quote')
        if (!revealed(range.from, range.to)) hide(range.from, range.to)
        break
      case 'bullet':
        if (taskLines.has(doc.lineAt(range.from).from)) hide(range.from, range.to)
        else if (!revealed(range.from, range.to)) {
          // 只换掉标记字符本身，后面的空格留着当缩进（换成 widget 后仍有视觉间距）
          decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(range.from, range.from + 1))
        }
        break
      case 'task':
        if (!revealed(range.from, range.to)) {
          decorations.push(
            Decoration.replace({
              widget: new CheckboxWidget(range.checked === true, range.from, range.to),
            }).range(range.from, range.to),
          )
        }
        break
      case 'image':
        if (!revealed(range.from, range.to)) {
          decorations.push(
            Decoration.replace({
              widget: new ImageWidget(range.url ?? '', range.text ?? '', host),
            }).range(range.from, range.to),
          )
        }
        break
      case 'code-fence-info':
        // 不藏 info 串：围栏行整体可见，这里只是把它染成语言标签
        if (range.to > range.from) {
          decorations.push(Decoration.mark({ class: 'cm-md-fence-lang' }).range(range.from, range.to))
        }
        break
      default:
        // strong/emphasis/inline-code/strikethrough/link：藏标记，正文样式由 styles 负责
        if (!revealed(range.from, range.to)) hide(range.from, range.to)
        break
    }
  }

  for (const [position, classes] of lineClasses) {
    decorations.push(Decoration.line({ class: classes.join(' ') }).range(position))
  }

  // sort=true：行装饰与同位置的替换装饰可能同序，交给 CM6 排序 + 合并
  return Decoration.set(decorations, true)
}

// 「哪些行展开」只用行号对描述：同一行内移动光标不需要重算装饰集。
// 这是打字/方向键路径上最省的一次判断（大文档下整块重算不便宜）。
function revealSignature(state: EditorState): string {
  return state.selection.ranges
    .map((range) => `${state.doc.lineAt(range.from).number}-${state.doc.lineAt(range.to).number}`)
    .join(',')
}

export function createMarkdownDecorations(host: MarkdownDecorationHost): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => buildMarkdownDecorations(state, host),
    update: (value, tr) => {
      // 语法树推进（后台解析完成）也要重算：新解析出的区域此前没有装饰
      const treeGrew = syntaxTree(tr.startState) !== syntaxTree(tr.state)
      if (!tr.docChanged && !tr.selection && !treeGrew) return value
      if (!tr.docChanged && !treeGrew && revealSignature(tr.startState) === revealSignature(tr.state)) return value
      return buildMarkdownDecorations(tr.state, host)
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}
