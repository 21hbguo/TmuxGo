// 元素选择器核心：CSS 选择器生成（antonmedv/finder 思路）、命中目标规整、React 组件名推断。
// 纯 DOM 实现，不穿透 shadow DOM（本仓无 shadow DOM）。

export const PICKER_UI_ATTR = 'data-element-picker-ui'

export interface PickedElementInfo {
  selector: string
  /** 悬停高亮用的短标签：tag#id.class */
  label: string
  tagName: string
  componentName: string | null
  attributes: { name: string; value: string }[]
  rect: { x: number; y: number; width: number; height: number }
  /** 命中 xterm 终端区域：面板只展示容器信息，不展开其内部 DOM */
  terminal: boolean
}

// 人工标注的定位属性优先于 class 链——它们才是测试/改代码时的稳定锚点
const LOCATOR_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy']
const MAX_ATTRS = 8
const MAX_ATTR_VALUE = 120

const cssEscape = (value: string) =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&')
const quoteAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
const countMatches = (selector: string) => {
  try {
    return document.querySelectorAll(selector).length
  } catch {
    return 0
  }
}

// 单级选择器。terminal=true 表示该级在全文档内已唯一（#id / 唯一定位属性），可截断向上攀爬
function selectorSegment(el: Element): { text: string; terminal: boolean } {
  const tag = el.localName
  if (el.id) {
    const sel = `#${cssEscape(el.id)}`
    if (countMatches(sel) === 1) return { text: sel, terminal: true }
  }
  for (const attr of LOCATOR_ATTRS) {
    const value = el.getAttribute(attr)
    if (value === null) continue
    const sel = value ? `${tag}[${attr}="${quoteAttr(value)}"]` : `${tag}[${attr}]`
    if (countMatches(sel) === 1) return { text: sel, terminal: true }
  }
  const base = tag + [...el.classList].map((name) => `.${cssEscape(name)}`).join('')
  const parent = el.parentElement
  if (!parent) return { text: base, terminal: false }
  if (base !== tag) {
    // class 组合在同级唯一就不必带序号
    const conflict = [...parent.children].some((sibling) => sibling !== el && sibling.matches(base))
    if (!conflict) return { text: base, terminal: false }
  }
  const sameTag = [...parent.children].filter((item) => item.localName === tag)
  if (sameTag.length > 1) return { text: `${base}:nth-of-type(${sameTag.indexOf(el) + 1})`, terminal: false }
  return { text: base, terminal: false }
}

// 自底向上拼 `a > b > c`，到 body 封顶；遇文档级唯一锚点提前截断
export function getCssPath(el: Element): string {
  if (!(el instanceof Element)) return ''
  if (el === document.documentElement) return 'html'
  const parts: string[] = []
  let node: Element | null = el
  while (node && node !== document.documentElement) {
    const seg = selectorSegment(node)
    parts.unshift(seg.text)
    if (seg.terminal || node === document.body) break
    node = node.parentElement
  }
  return parts.join(' > ')
}

// 喂给 pane/agent 的紧凑定位串：组件名 + selector 末两段。
// 全长路径前几层（#root/main 外壳容器）对定位源码是噪音，组件名才是直指文件的锚点
export function insertText(info: PickedElementInfo): string {
  const tail = info.selector.split(' > ').slice(-2).join(' > ')
  return info.componentName ? `${info.componentName} > ${tail}` : tail
}

export function elementLabel(el: Element): string {
  const id = el.id ? `#${el.id}` : ''
  const classes = [...el.classList]
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join('')
  return `${el.localName}${id}${classes}`
}

// React 会把 fiber 挂在 DOM 的 __reactFiber$* / __reactContainer$* 键上（生产构建同样存在，
// 只是组件名可能被压缩）。沿 return 链找第一个有名函数/类组件；拿不到返回 null
export function componentNameOf(el: Element): string | null {
  const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactContainer$'))
  let fiber: any = key ? (el as any)[key] : null
  while (fiber) {
    const type = fiber.type
    if (typeof type === 'function' && (type.displayName || type.name)) return type.displayName || type.name
    // forwardRef/memo 包裹：真实组件在 render/type 上
    const inner = type && typeof type === 'object' ? type.render || type.type : null
    if (typeof inner === 'function' && (inner.displayName || inner.name)) return inner.displayName || inner.name
    fiber = fiber.return
  }
  return null
}

// 命中规整：拾取器自身 UI 不入选；命中 xterm 内部时抬升到 [data-terminal] 容器。
// 入参放宽到 EventTarget——window/document 等非元素命中（如滚动条）直接判空
export function resolvePickTarget(el: EventTarget | null | undefined): Element | null {
  if (!(el instanceof Element) || el === document.documentElement || el === document.body) return null
  if (el.closest(`[${PICKER_UI_ATTR}]`)) return null
  const terminal = el.closest('[data-terminal]')
  if (terminal) return terminal
  const xterm = el.closest('.xterm')
  if (xterm) return xterm
  return el
}

export function describeElement(el: Element): PickedElementInfo {
  const rect = el.getBoundingClientRect()
  const attributes: { name: string; value: string }[] = []
  for (const attr of el.attributes) {
    if (attributes.length >= MAX_ATTRS) break
    // class/style 由 label 与 rect 承载，不进属性摘要
    if (attr.name === 'class' || attr.name === 'style') continue
    attributes.push({ name: attr.name, value: attr.value.slice(0, MAX_ATTR_VALUE) })
  }
  return {
    selector: getCssPath(el),
    label: elementLabel(el),
    tagName: el.localName,
    componentName: componentNameOf(el),
    attributes,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    terminal: !!el.closest('[data-terminal],.xterm'),
  }
}
