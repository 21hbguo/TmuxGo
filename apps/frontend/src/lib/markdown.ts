import { marked, type Token, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import {
  isIndentedCodeLine,
  resolveImageRef,
  type MarkdownAssetContext,
  type MarkdownImageRef,
} from './markdown-assets'

export type { MarkdownAssetContext, MarkdownImageKind, MarkdownImageRef } from './markdown-assets'

type MarkedRenderer = InstanceType<typeof marked.Renderer>
// 调试收集槽：临时排障用，挂在 globalThis 上缺省不存在
type MdCollectGlobal = typeof globalThis & {
  __mdCollect?: { t: string; raw: string; off: number; l: number }[]
}
interface MarkdownSegment {
  text: string
  offset: number
  code: boolean
}
export interface MarkdownRenderOptions {
  /** 图片路径解析上下文；缺省时本地图一律标成 missing-context（不瞎猜路径） */
  asset?: MarkdownAssetContext
  /** 默认 true：给标题加 GitHub 风格 slug id */
  headingIds?: boolean
}
export interface MarkdownHeading {
  id: string
  text: string
  line: number
}
export interface MarkdownRenderResult {
  html: string
  images: MarkdownImageRef[]
  headings: MarkdownHeading[]
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/
const BLANK_LINE_RE = /^\s*$/
// 1x1 透明 GIF：本地图在 blob 到位前先占位，避免浏览器画出裂图图标
const IMAGE_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
// 收紧 sanitize：可执行/可外链注入的标签与内联样式一律禁入。
// 注意不要动 ALLOWED_URI_REGEXP：javascript: 必须继续被剥，图片只放行 data:image（DOMPurify 对 img 自带白名单）
const SANITIZE_OPTIONS = {
  FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style'],
  ADD_ATTR: [
    'target',
    'rel',
    'loading',
    'referrerpolicy',
    'width',
    'height',
    'data-md-src',
    'data-md-path',
    'data-md-kind',
    'data-md-state',
    'data-md-reason',
    'data-md-external',
  ],
  ALLOW_DATA_ATTR: true,
}

interface MarkdownLine {
  text: string
  offset: number
  /** 行尾（不含换行符） */
  end: number
}

function splitLines(content: string): MarkdownLine[] {
  const lines: MarkdownLine[] = []
  let offset = 0
  while (offset <= content.length) {
    const newline = content.indexOf('\n', offset)
    if (newline === -1) {
      lines.push({ text: content.slice(offset), offset, end: content.length })
      break
    }
    lines.push({ text: content.slice(offset, newline), offset, end: newline })
    offset = newline + 1
  }
  return lines
}

// 分段：围栏代码（``` / ~~~）与 4 空格缩进代码块单独切出来。
// 原因：非代码段要执行 `\n{3,}` → `<br>` 的保留空行替换（breaks:true 下 markdown 会吞空行），
// 代码段一旦被替换就会污染源码；旧实现只认 ``` 且无法处理未闭合围栏，会把代码尾巴当正文。
function splitMarkdownSegments(content: string) {
  const segments: MarkdownSegment[] = []
  const push = (text: string, offset: number, code: boolean) => {
    if (text) segments.push({ text, offset, code })
  }
  const lines = splitLines(content)
  let plainFrom = 0
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const fence = FENCE_OPEN_RE.exec(line.text)
    if (fence) {
      const marker = fence[1]
      // 闭合围栏：同字符、长度不短于开围栏、最多 3 空格缩进、其后只能是空白
      const closeRe = new RegExp(`^ {0,3}(\\${marker[0]}{${marker.length},})\\s*$`)
      let cursor = index + 1
      while (cursor < lines.length && !closeRe.test(lines[cursor].text)) cursor += 1
      push(content.slice(plainFrom, line.offset), plainFrom, false)
      const end = cursor < lines.length ? lines[cursor].end : content.length
      push(content.slice(line.offset, end), line.offset, true)
      plainFrom = end
      index = cursor + 1
      continue
    }
    const previous = index > 0 ? lines[index - 1] : null
    // 缩进代码块不能打断段落，也不承接列表项的悬挂缩进，所以要求「上一行是空行或文首」
    if (isIndentedCodeLine(line.text) && (!previous || BLANK_LINE_RE.test(previous.text))) {
      let cursor = index
      let lastCode = index
      while (cursor < lines.length) {
        const current = lines[cursor].text
        if (BLANK_LINE_RE.test(current)) {
          cursor += 1
          continue
        }
        if (!isIndentedCodeLine(current)) break
        lastCode = cursor
        cursor += 1
      }
      push(content.slice(plainFrom, line.offset), plainFrom, false)
      const end = lines[lastCode].end
      push(content.slice(line.offset, end), line.offset, true)
      plainFrom = end
      index = lastCode + 1
      continue
    }
    index += 1
  }
  push(content.slice(plainFrom), plainFrom, false)
  return segments
}
// 行号查询器：块级 token 的绝对 offset → 行号。
// 旧实现每个块都 countLines(content.slice(0, offset))，200KB 文档下是 O(n²)
// （实测 3.8s），这里改成单指针顺序推进 + 回退重扫兜底，整体 O(n)。
function createLineCounter(content: string) {
  let scanned = 0
  let lines = 1
  return (offset: number) => {
    if (offset < scanned) {
      scanned = 0
      lines = 1
    }
    while (scanned < offset) {
      if (content.charCodeAt(scanned) === 10) lines += 1
      scanned += 1
    }
    return lines
  }
}
const LINE_BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'list_item', 'blockquote', 'code', 'table', 'hr'])
function collectBlockLines(content: string) {
  const lines: number[] = []
  ;(globalThis as MdCollectGlobal).__mdCollect = []
  const segments = splitMarkdownSegments(content)
  const lineOf = createLineCounter(content)
  const walk = (tokens: Token[], text: string, baseOffset: number) => {
    let from = 0
    for (const token of tokens) {
      if (token.type === 'space') {
        from += token.raw.length
        continue
      }
      const index = text.indexOf(token.raw, from)
      const start = index === -1 ? from : index
      if (LINE_BLOCK_TYPES.has(token.type)) {
        const l = lineOf(baseOffset + start)
        lines.push(l)
        ;(globalThis as MdCollectGlobal).__mdCollect!.push({
          t: token.type,
          raw: token.raw.slice(0, 12),
          off: baseOffset + start,
          l,
        })
      }
      from = start + token.raw.length
      if (token.type === 'list') walk(token.items, token.raw, baseOffset + start)
      else if (token.type === 'list_item' || token.type === 'blockquote')
        walk(token.tokens!, token.raw, baseOffset + start)
    }
  }
  for (const segment of segments) {
    walk(marked.lexer(segment.text), segment.text, segment.offset)
  }
  return lines
}
function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function stripTags(value: string) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
// GitHub 风格 slug：小写、去标点、空白转 `-`；重名追加 `-1`/`-2`。
// 保留 Unicode 字母数字（中文标题要能生成可用锚点，而不是空 id）
function slugifyHeading(text: string) {
  const slug = text
    .normalize('NFKC')
    .toLowerCase()
    // \p{Cc} 等价于 C0/C1 控制字符，但不会被 no-control-regex 判为可疑字面量
    .replace(/\p{Cc}/gu, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
  return slug || 'section'
}
function createSlugger() {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = slugifyHeading(text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count ? `${base}-${count}` : base
  }
}
function createLineRenderer(
  lines: number[],
  options: MarkdownRenderOptions | undefined,
  images: MarkdownImageRef[],
  headings: MarkdownHeading[],
) {
  let index = 0
  const take = () => lines[index++] ?? 1
  const nextSlug = createSlugger()
  const withHeadingIds = options?.headingIds !== false
  const proto = marked.Renderer.prototype
  const renderer = new marked.Renderer()
  const heading = proto.heading
  renderer.heading = function (this: MarkedRenderer, token: Tokens.Heading) {
    const line = take()
    const html = heading.call(this, token)
    const text = stripTags(html.replace(/^<h[1-6]>/, '').replace(/<\/h[1-6]>\s*$/, ''))
    const id = withHeadingIds ? nextSlug(text) : ''
    headings.push({ id, text, line })
    const attrs = `data-line="${line}"${id ? ` id="${escapeAttr(id)}"` : ''}`
    return html.replace(/^<h([1-6])>/, (_: string, depth: string) => `<h${depth} ${attrs}>`)
  }
  const paragraph = proto.paragraph
  renderer.paragraph = function (this: MarkedRenderer, token: Tokens.Paragraph) {
    const line = take()
    return paragraph.call(this, token).replace(/^<p>/, () => `<p data-line="${line}">`)
  }
  const list = proto.list
  renderer.list = function (this: MarkedRenderer, token: Tokens.List) {
    const line = take()
    return list.call(this, token).replace(/^<(ul|ol)\b/, (_: string, tag: string) => `<${tag} data-line="${line}"`)
  }
  const listitem = proto.listitem
  renderer.listitem = function (this: MarkedRenderer, token: Tokens.ListItem) {
    const line = take()
    return listitem.call(this, token).replace(/^<li>/, () => `<li data-line="${line}">`)
  }
  const blockquote = proto.blockquote
  renderer.blockquote = function (this: MarkedRenderer, token: Tokens.Blockquote) {
    const line = take()
    return blockquote.call(this, token).replace(/^<blockquote>/, () => `<blockquote data-line="${line}">`)
  }
  const code = proto.code
  renderer.code = function (this: MarkedRenderer, token: Tokens.Code) {
    const line = take()
    return code.call(this, token).replace(/^<pre>/, () => `<pre data-line="${line}">`)
  }
  const table = proto.table
  renderer.table = function (this: MarkedRenderer, token: Tokens.Table) {
    const line = take()
    // 宽表不能在正文里被压扁：外层给横向滚动容器；data-line 留在 table 上供双击定位
    const html = table.call(this, token).replace(/^<table>/, () => `<table data-line="${line}">`)
    return `<div class="md-table-wrap">${html}</div>`
  }
  const hr = proto.hr
  renderer.hr = function (this: MarkedRenderer, token: Tokens.Hr) {
    const line = take()
    return hr.call(this, token).replace(/^<hr/, () => `<hr data-line="${line}"`)
  }
  // 图片：能解析的本地图先放 1x1 占位 + data-md-*，由 MarkdownPreview 换成 blob URL；
  // 远程/内联直连；解析失败（越界/无上下文/危险 scheme）也占位并标 unsupported，绝不把裂图交给浏览器
  renderer.image = function (token: Tokens.Image) {
    const ref = resolveImageRef(token.href || '', options?.asset)
    images.push(ref)
    const alt = escapeAttr(token.text || '')
    const title = token.title ? ` title="${escapeAttr(token.title)}"` : ''
    if (ref.kind === 'external' || ref.kind === 'data') {
      const src = escapeAttr(ref.rawSrc.trim())
      return `<img src="${src}" data-md-src="${src}" data-md-kind="${ref.kind}" alt="${alt}"${title} loading="lazy" referrerpolicy="no-referrer">`
    }
    if (!ref.resolvedPath) {
      const reason = ref.reason || 'unsupported'
      // 危险 scheme 不回显原始 src：data-* 对浏览器无行为，但没必要把 javascript: 留在 DOM 里
      const meta =
        ref.kind === 'invalid'
          ? `data-md-kind="${ref.kind}"`
          : `data-md-src="${escapeAttr(ref.rawSrc)}" data-md-kind="${ref.kind}"`
      return `<img ${meta} data-md-state="unsupported" data-md-reason="${reason}" src="${IMAGE_PLACEHOLDER_SRC}" alt="${alt}"${title}>`
    }
    // 属性顺序固定为 src→path→kind→src，预览组件与测试都按这个契约读
    return `<img data-md-src="${escapeAttr(ref.rawSrc)}" data-md-path="${escapeAttr(ref.resolvedPath)}" data-md-kind="${ref.kind}" src="${IMAGE_PLACEHOLDER_SRC}" alt="${alt}"${title}>`
  }
  // 外链：DOMPurify 默认保留 target 需要 ADD_ATTR（见 SANITIZE_OPTIONS），
  // 组件再按 data-md-external 拦截点击走 onOpenExternal，避免 SPA 被整页导航走
  renderer.link = function (this: MarkedRenderer, token: Tokens.Link) {
    const href = token.href || ''
    const title = token.title ? ` title="${escapeAttr(token.title)}"` : ''
    const inner = this.parser.parseInline(token.tokens)
    if (/^(?:https?:)?\/\//i.test(href.trim())) {
      return `<a href="${escapeAttr(href)}"${title} target="_blank" rel="noopener noreferrer" data-md-external="1">${inner}</a>`
    }
    return `<a href="${escapeAttr(href)}"${title}>${inner}</a>`
  }
  return renderer
}
export function renderMarkdownDocument(content: string, options?: MarkdownRenderOptions): MarkdownRenderResult {
  const segments = splitMarkdownSegments(content)
  const images: MarkdownImageRef[] = []
  const headings: MarkdownHeading[] = []
  const renderer = createLineRenderer(collectBlockLines(content), options, images, headings)
  const parts = segments.map((segment) =>
    segment.code
      ? (marked.parse(segment.text, { gfm: true, renderer }) as string)
      : (marked.parse(
          segment.text.replace(/\n{3,}/g, (m) => '<br>'.repeat(m.length - 2) + '\n\n'),
          { gfm: true, breaks: true, renderer },
        ) as string),
  )
  return { html: DOMPurify.sanitize(parts.join('\n'), SANITIZE_OPTIONS), images, headings }
}
export function renderMarkdown(content: string, options?: MarkdownRenderOptions) {
  return renderMarkdownDocument(content, options).html
}
export function locatePreviewBlock(article: HTMLElement, line: number): HTMLElement | null {
  const blocks = Array.from(article.querySelectorAll<HTMLElement>('[data-line]'))
  let target: HTMLElement | null = null
  for (const block of blocks) {
    const start = Number(block.getAttribute('data-line'))
    if (start <= line) target = block
    else break
  }
  // 光标在首个块上方（如文件首行空行/frontmatter）时回落到第一个块
  return target || blocks[0] || null
}
export const MARKDOWN_PROSE_CLASS =
  'markdown-prose prose max-w-none text-sm text-text-2 [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--line)] [&_blockquote]:pl-3 [&_blockquote]:not-italic [&_blockquote]:text-text-2 [&_code]:rounded-apple [&_code]:bg-bg-2 [&_code]:text-text-1 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:before:content-none [&_code]:after:content-none [&_h1]:mb-4 [&_h1]:text-[1.9em] [&_h1]:text-text-1 [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-[1.55em] [&_h2]:text-text-1 [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-[1.3em] [&_h3]:text-text-1 [&_h4]:mt-4 [&_h4]:text-[1.15em] [&_h4]:text-text-1 [&_h5]:mt-4 [&_h5]:text-[1em] [&_h5]:text-text-1 [&_h6]:mt-3 [&_h6]:text-[0.9em] [&_h6]:text-text-1 [&_hr]:my-4 [&_hr]:border-[var(--line)] [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-apple [&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:align-middle [&_li]:mb-1 [&_li>p]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_pre]:relative [&_pre]:overflow-auto [&_pre]:rounded-apple [&_pre]:bg-bg-0 [&_pre]:p-4 [&_pre]:text-text-1 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:text-text-1 [&_table]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_table]:border [&_table]:border-[var(--line)] [&_td]:border [&_td]:border-[var(--line)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--line)] [&_th]:bg-bg-2/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:text-text-1 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5'
