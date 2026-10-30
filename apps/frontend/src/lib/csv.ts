// RFC4180 简版解析：支持双引号字段、"" 转义、字段内换行与 CRLF。
// 分隔符可探测（, ; \t |）：Excel/BI 导出常见分号与制表符，只认逗号会把整行塞进第一列。
// BOM 默认剥离：Excel 导出的 UTF-8 CSV 带 U+FEFF，不剥会让首列表头带不可见字符，复制到 Excel 后比对失败。
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const
export interface CsvParseOptions {
  delimiter?: string
  stripBom?: boolean
}
export interface CsvParseResult {
  rows: string[][]
  delimiter: string
  hadBom: boolean
}
// 引号外的候选分隔符计数：前 5 个非空行足够区分 , 与 ;，又不会被正文里的逗号带偏
export function detectDelimiter(content: string) {
  const counts = new Map<string, number>(CSV_DELIMITERS.map((delimiter) => [delimiter, 0]))
  let lines = 0
  let inQuotes = false
  for (let i = 0; i < content.length && lines < 5; i++) {
    const ch = content[i]
    if (ch === '"') {
      // "" 是转义引号，不改变引号状态
      if (inQuotes && content[i + 1] === '"') i++
      else inQuotes = !inQuotes
      continue
    }
    if (inQuotes) continue
    if (ch === '\n') {
      // 连续空行不占名额，避免探测窗口被空行吃掉
      if (content[i - 1] !== '\n' && i > 0) lines++
      continue
    }
    const count = counts.get(ch)
    if (count !== undefined) counts.set(ch, count + 1)
  }
  let best = ','
  let bestCount = 0
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}
function parseRows(content: string, delimiter: string) {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (ch === delimiter) {
      pushField()
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++
      pushRow()
      continue
    }
    field += ch
  }
  pushField()
  rows.push(row)
  return rows
}
export function parseCsvTable(content: string, options: CsvParseOptions = {}): CsvParseResult {
  const stripBom = options.stripBom !== false
  const hadBom = stripBom && content.charCodeAt(0) === 0xfeff
  const text = hadBom ? content.slice(1) : content
  const delimiter = options.delimiter || detectDelimiter(text)
  // 空文件/纯空白等价于无数据；注意 '\n' 会解析出两个空行，必须先拦掉
  if (!text.trim()) return { rows: [], delimiter, hadBom }
  const rows = parseRows(text, delimiter)
  // 只丢掉「文件末尾换行」产生的那一个空行；连续空行是用户数据（复制少行比多空行更糟）
  const last = rows[rows.length - 1]
  if (rows.length > 1 && last?.length === 1 && last[0] === '') rows.pop()
  return { rows, delimiter, hadBom }
}
export function parseCsv(content: string, options: CsvParseOptions = {}): string[][] {
  return parseCsvTable(content, options).rows
}
function quoteField(value: string, delimiter: string) {
  // 引号、换行、分隔符出现时才加引号；这是 Excel/Numbers 都能正确识别的保守规则
  if (/["\r\n]/.test(value) || (delimiter && value.includes(delimiter))) return `"${value.replace(/"/g, '""')}"`
  return value
}
export function serializeDelimited(rows: string[][], delimiter = ',') {
  return rows.map((row) => row.map((cell) => quoteField(cell, delimiter)).join(delimiter)).join('\n')
}
export function serializeTsv(rows: string[][]) {
  return serializeDelimited(rows, '\t')
}
export function toMarkdownTable(rows: string[][]) {
  if (!rows.length) return ''
  const escape = (cell: string) => cell.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|')
  const columns = Math.max(...rows.map((row) => row.length))
  const line = (row: string[]) =>
    `| ${Array.from({ length: columns }, (_, index) => escape(row[index] ?? '')).join(' | ')} |`
  const [header, ...body] = rows
  return [
    line(header ?? []),
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
    ...body.map(line),
  ].join('\n')
}
export interface CsvTableSlice {
  rows: string[][]
  totalRows: number
  totalCols: number
  truncatedRows: number
  truncatedCols: number
}
// 展示切片：只截 DOM 行数/列数，数据仍保留完整 rows 供复制（复制读原数组）
export function sliceTable(rows: string[][], maxRows: number, maxCols: number): CsvTableSlice {
  const totalRows = rows.length
  // reduce 而不是 Math.max(...spread)：十万行级展开传参会 RangeError，直接打崩整个工作台
  const totalCols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const shownRows = rows.slice(0, Math.max(0, maxRows))
  return {
    rows: shownRows.map((row) => row.slice(0, Math.max(0, maxCols))),
    totalRows,
    totalCols,
    truncatedRows: Math.max(0, totalRows - shownRows.length),
    truncatedCols: Math.max(0, totalCols - Math.max(0, maxCols)),
  }
}
export function compareCsvValues(a: string, b: string) {
  const left = a.trim()
  const right = b.trim()
  // 纯数字按数值比较（"10" > "9"），否则按本地化排序（中文按拼音、数字串自然序）
  if (/^-?\d+(?:\.\d+)?$/.test(left) && /^-?\d+(?:\.\d+)?$/.test(right)) return Number(left) - Number(right)
  return left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}
export function sortTableRows(rows: string[][], column: number, direction: 'asc' | 'desc', hasHeader: boolean) {
  if (!rows.length) return rows
  const header = hasHeader ? rows[0] : null
  const body = hasHeader ? rows.slice(1) : rows.slice()
  const sign = direction === 'asc' ? 1 : -1
  body.sort((left, right) => sign * compareCsvValues(left[column] ?? '', right[column] ?? ''))
  return header ? [header, ...body] : body
}
export function filterTableRows(rows: string[][], query: string, hasHeader: boolean) {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  const header = hasHeader ? rows[0] : null
  const body = hasHeader ? rows.slice(1) : rows
  const matched = body.filter((row) => row.some((cell) => cell.toLowerCase().includes(needle)))
  return header ? [header, ...matched] : matched
}
