// GFM 表格解析：只做 live preview 的展示模型，不改源码、不做完整 inline 语义。
// 与 marked 的表格渲染保持同一套规则：外框竖线可省、`\|` 转义、反引号内的 | 不切分、
// 分隔行决定对齐、数据行多出的单元格丢弃、缺的补空。
export type MarkdownTableAlign = 'left' | 'center' | 'right' | null

export interface MarkdownTableModel {
  header: string[]
  aligns: MarkdownTableAlign[]
  rows: string[][]
}

const SEPARATOR_CELL = /^:?-{1,}:?$/

function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let escaped = false
  let tick = false
  for (const char of line.trim()) {
    if (escaped) {
      current += char === '|' ? '|' : `\\${char}`
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '`') tick = !tick
    if (char === '|' && !tick) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  // 首尾的框线会产生空单元格：只去掉最外一层，保留中间的空列
  if (cells.length > 1 && cells[0] === '') cells.shift()
  if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop()
  return cells
}

function parseAlign(cell: string): MarkdownTableAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

export function parseMarkdownTable(source: string): MarkdownTableModel | null {
  const lines = source.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2) return null
  const header = splitRow(lines[0])
  const separator = splitRow(lines[1])
  if (!header.length || separator.length !== header.length) return null
  if (!separator.every((cell) => SEPARATOR_CELL.test(cell))) return null
  const aligns = separator.map(parseAlign)
  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line)
    return header.map((_, index) => cells[index] ?? '')
  })
  return { header, aligns, rows }
}

// live widget 的极简 inline 渲染：只认行内码/加粗/斜体，链接只上色不跳转（点击表格是「回到源码」）。
// 用 DOM API 而不是 innerHTML：表格内容来自用户文件，不引入第二条 sanitize 路径。
export function renderInlineMarkdown(parent: HTMLElement, text: string) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, index)))
    const token = match[0]
    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.className = 'cm-md-inline-code'
      code.textContent = token.slice(1, -1)
      parent.appendChild(code)
    } else {
      const strong = document.createElement(token.startsWith('**') ? 'strong' : 'em')
      strong.textContent = token.replace(/^\*\*?|\*\*?$/g, '')
      parent.appendChild(strong)
    }
    cursor = index + token.length
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)))
}
