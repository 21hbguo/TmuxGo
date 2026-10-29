// 编辑区状态栏的纯逻辑：行尾/缩进探测、选区统计、语言显示名。
// 单独成文件是为了可单测——状态栏组件本身只负责排版与交互。
export type EditorEol = '\n' | '\r\n'

export interface EditorEolInfo {
  eol: EditorEol
  // 混合行尾：\r\n 与裸 \n 同时出现。转换会顺手统一，转换前要能让用户看见风险
  mixed: boolean
}

// 行尾探测只看前 2MB：超大文件全量扫描会把打开文件的主线程卡住，
// 而一段文件的行尾风格在实际使用中足够稳定
const EOL_SAMPLE_LIMIT = 2 * 1024 * 1024
const INDENT_SAMPLE_LINES = 400

export function detectEol(content: string): EditorEolInfo {
  const sample = content.length > EOL_SAMPLE_LIMIT ? content.slice(0, EOL_SAMPLE_LIMIT) : content
  let crlf = 0
  let lf = 0
  for (let index = sample.indexOf('\n'); index >= 0; index = sample.indexOf('\n', index + 1)) {
    if (index > 0 && sample.charCodeAt(index - 1) === 13) crlf += 1
    else lf += 1
  }
  return { eol: crlf > lf ? '\r\n' : '\n', mixed: crlf > 0 && lf > 0 }
}

export function convertEol(content: string, eol: EditorEol): string {
  const normalized = content.replace(/\r\n?/g, '\n')
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
}

export interface EditorIndentInfo {
  tabSize: number
  insertSpaces: boolean
}

export const DEFAULT_INDENT: EditorIndentInfo = { tabSize: 2, insertSpaces: true }
const VALID_TAB_SIZES = [2, 4, 6, 8]

// 缩进探测对齐 VSCode 的启发式：制表符缩进行占优就用 Tab，否则取最小空格缩进宽度
// （只认 2/3/4/6/8，避免把对齐用的奇数缩进当成 tabSize）
export function detectIndent(content: string, fallback: EditorIndentInfo = DEFAULT_INDENT): EditorIndentInfo {
  let tabLines = 0
  let smallestSpaces = 0
  let scanned = 0
  for (const line of content.split('\n')) {
    if (scanned++ >= INDENT_SAMPLE_LINES) break
    if (!line.trim()) continue
    const indent = line.slice(0, line.length - line.trimStart().length)
    if (!indent) continue
    if (indent.startsWith('\t')) {
      tabLines += 1
      continue
    }
    if (!smallestSpaces || indent.length < smallestSpaces) smallestSpaces = indent.length
  }
  if (tabLines > 0 && (!smallestSpaces || tabLines >= 2)) return { tabSize: fallback.tabSize, insertSpaces: false }
  const tabSize = VALID_TAB_SIZES.find((size) => size === smallestSpaces) || fallback.tabSize
  return { tabSize, insertSpaces: smallestSpaces > 0 ? true : fallback.insertSpaces }
}

export interface EditorSelectionRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface EditorSelectionStats {
  lines: number
  chars: number
}

// 选区统计：单行选区按列差算字符数，跨行按「逐行长度求和」；
// getLineLength 由调用方给（Monaco 模型 getLineLength），避免这里再持有模型
export function computeSelectionStats(
  range: EditorSelectionRange | null | undefined,
  getLineLength: (line: number) => number,
): EditorSelectionStats | null {
  if (!range) return null
  const { startLineNumber, startColumn, endLineNumber, endColumn } = range
  if (endLineNumber < startLineNumber) return null
  if (startLineNumber === endLineNumber) {
    const chars = endColumn - startColumn
    return chars > 0 ? { lines: 1, chars } : null
  }
  let chars = 0
  for (let line = startLineNumber; line <= endLineNumber; line += 1) {
    const length = Math.max(0, getLineLength(line))
    if (line === startLineNumber) {
      chars += Math.max(0, length - startColumn + 1)
      // 跨行时选区包含行尾换行，与 VSCode 的 "N selected" 口径一致
      if (endLineNumber > startLineNumber) chars += 1
    } else if (line === endLineNumber) chars += Math.max(0, Math.min(endColumn - 1, length))
    else chars += length + 1
  }
  return { lines: endLineNumber - startLineNumber + 1, chars }
}

// 语言显示名：状态栏用 VSCode 的写法（TypeScript / Plain Text / Shell Script…），
// 未收录的退回原始 language id，避免出现空白
const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  xml: 'XML',
  shell: 'Shell Script',
  python: 'Python',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  rust: 'Rust',
  php: 'PHP',
  ruby: 'Ruby',
  sql: 'SQL',
  yaml: 'YAML',
  ini: 'INI',
  toml: 'TOML',
  dockerfile: 'Dockerfile',
  c: 'C',
  cpp: 'C++',
  csv: 'CSV',
  plaintext: 'Plain Text',
}

export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] || language
}

export type EolLabel = 'LF' | 'CRLF'

export function eolLabel(eol: EditorEol): EolLabel {
  return eol === '\r\n' ? 'CRLF' : 'LF'
}
