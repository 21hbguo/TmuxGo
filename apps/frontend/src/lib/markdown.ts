import { marked } from 'marked'
import DOMPurify from 'dompurify'
interface MarkdownSegment {
  text: string
  offset: number
  code: boolean
}
function splitMarkdownSegments(content: string) {
  const segments: MarkdownSegment[] = []
  let last = 0
  const codePattern = /```[\s\S]*?```/g
  let match: RegExpExecArray | null
  while ((match = codePattern.exec(content))) {
    segments.push({ text: content.slice(last, match.index), offset: last, code: false })
    segments.push({ text: match[0], offset: match.index, code: true })
    last = match.index + match[0].length
  }
  segments.push({ text: content.slice(last), offset: last, code: false })
  return segments
}
function countLines(text: string) {
  let count = 0
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') count++
  return count
}
const LINE_BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'list_item', 'blockquote', 'code', 'table', 'hr'])
function collectBlockLines(content: string) {
  const lines: number[] = []
  ;(globalThis as any).__mdCollect = []
  const segments = splitMarkdownSegments(content)
  const walk = (tokens: any[], text: string, baseOffset: number) => {
    let from = 0
    for (const token of tokens) {
      if (token.type === 'space') {
        from += token.raw.length
        continue
      }
      const index = text.indexOf(token.raw, from)
      const start = index === -1 ? from : index
      if (LINE_BLOCK_TYPES.has(token.type)) {
        const l = 1 + countLines(content.slice(0, baseOffset + start))
        lines.push(l)
        ;(globalThis as any).__mdCollect.push({
          t: token.type,
          raw: token.raw.slice(0, 12),
          off: baseOffset + start,
          l,
        })
      }
      from = start + token.raw.length
      if (token.type === 'list') walk(token.items, token.raw, baseOffset + start)
      else if (token.type === 'list_item' || token.type === 'blockquote')
        walk(token.tokens, token.raw, baseOffset + start)
    }
  }
  for (const segment of segments) {
    walk(marked.lexer(segment.text) as any[], segment.text, segment.offset)
  }
  return lines
}
function createLineRenderer(lines: number[]) {
  let index = 0
  const take = () => lines[index++] ?? 1
  const proto = marked.Renderer.prototype
  const renderer = new marked.Renderer()
  const heading = proto.heading
  renderer.heading = function (this: any, token: any) {
    const line = take()
    return heading
      .call(this, token)
      .replace(/^<h([1-6])>/, (_: string, depth: string) => `<h${depth} data-line="${line}">`)
  }
  const paragraph = proto.paragraph
  renderer.paragraph = function (this: any, token: any) {
    const line = take()
    return paragraph.call(this, token).replace(/^<p>/, () => `<p data-line="${line}">`)
  }
  const list = proto.list
  renderer.list = function (this: any, token: any) {
    const line = take()
    return list.call(this, token).replace(/^<(ul|ol)\b/, (_: string, tag: string) => `<${tag} data-line="${line}"`)
  }
  const listitem = proto.listitem
  renderer.listitem = function (this: any, token: any) {
    const line = take()
    return listitem.call(this, token).replace(/^<li>/, () => `<li data-line="${line}">`)
  }
  const blockquote = proto.blockquote
  renderer.blockquote = function (this: any, token: any) {
    const line = take()
    return blockquote.call(this, token).replace(/^<blockquote>/, () => `<blockquote data-line="${line}">`)
  }
  const code = proto.code
  renderer.code = function (this: any, token: any) {
    const line = take()
    return code.call(this, token).replace(/^<pre>/, () => `<pre data-line="${line}">`)
  }
  const table = proto.table
  renderer.table = function (this: any, token: any) {
    const line = take()
    return table.call(this, token).replace(/^<table>/, () => `<table data-line="${line}">`)
  }
  const hr = proto.hr
  renderer.hr = function (this: any, token: any) {
    const line = take()
    return hr.call(this, token).replace(/^<hr/, () => `<hr data-line="${line}"`)
  }
  return renderer
}
export function renderMarkdown(content: string) {
  const segments = splitMarkdownSegments(content)
  const renderer = createLineRenderer(collectBlockLines(content))
  const parts = segments.map((segment) =>
    segment.code
      ? (marked.parse(segment.text, { gfm: true, renderer }) as string)
      : (marked.parse(
          segment.text.replace(/\n{3,}/g, (m) => '<br>'.repeat(m.length - 2) + '\n\n'),
          { gfm: true, breaks: true, renderer },
        ) as string),
  )
  return DOMPurify.sanitize(parts.join('\n'))
}
export const MARKDOWN_PROSE_CLASS =
  'prose max-w-none text-sm text-text-2 [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--line)] [&_blockquote]:pl-3 [&_blockquote]:not-italic [&_blockquote]:text-text-2 [&_code]:rounded-apple [&_code]:bg-bg-2 [&_code]:text-text-1 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:before:content-none [&_code]:after:content-none [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:text-text-1 [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-2xl [&_h2]:text-text-1 [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-xl [&_h3]:text-text-1 [&_h4]:mt-4 [&_h4]:text-lg [&_h4]:text-text-1 [&_h5]:mt-4 [&_h5]:text-base [&_h5]:text-text-1 [&_h6]:mt-3 [&_h6]:text-sm [&_h6]:text-text-1 [&_hr]:my-4 [&_hr]:border-[var(--line)] [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-apple [&_li]:mb-1 [&_li>p]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-apple [&_pre]:bg-bg-0 [&_pre]:p-4 [&_pre]:text-text-1 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:text-text-1 [&_table]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_table]:border [&_table]:border-[var(--line)] [&_td]:border [&_td]:border-[var(--line)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--line)] [&_th]:bg-bg-2/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:text-text-1 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5'
