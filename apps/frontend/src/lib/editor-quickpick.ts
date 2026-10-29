// quick pick 的纯逻辑：模糊打分 + 过滤 + `Ctrl+G` 行号解析 + 键盘游标环绕。
// 打分规则刻意保持确定性（无随机、无时钟），保证测试可断言且排序稳定。
export interface QuickPickItem<T = unknown> {
  id: string
  label: string
  detail?: string
  description?: string
  keywords?: string[]
  data?: T
}

const SCORE = {
  exact: 10_000,
  prefix: 8_000,
  wordStart: 6_000,
  contains: 4_000,
  subsequence: 2_000,
  keyword: 1_000,
} as const

const isWordBoundary = (text: string, index: number) =>
  index === 0 || /[\s\-_./:.()[\]]/.test(text.charAt(index - 1))

// 子序列匹配：查询词的字符按序出现即算命中，命中越紧凑、越贴词首分越高
function subsequenceScore(query: string, text: string): number {
  let score = 0
  let textIndex = 0
  let lastMatch = -2
  for (const char of query) {
    const found = text.indexOf(char, textIndex)
    if (found < 0) return 0
    score += found === lastMatch + 1 ? 6 : 2
    if (isWordBoundary(text, found)) score += 4
    lastMatch = found
    textIndex = found + 1
  }
  // 越短的目标越像用户想要的（精确度高），给个轻量反向权重
  return score - Math.min(20, Math.floor(text.length / 4))
}

export function scoreQuery(query: string, label: string, keywords: string[] = []): number {
  const raw = query.trim()
  if (!raw) return 1
  const q = raw.toLowerCase()
  const text = label.toLowerCase()
  if (text === q) return SCORE.exact
  if (text.startsWith(q)) return SCORE.prefix - Math.min(500, text.length)
  const wordStart = text.split(/[\s\-_./:()[\]]+/).some((word) => word && word.startsWith(q))
  if (wordStart) return SCORE.wordStart - Math.min(500, text.indexOf(q) + text.length)
  const contains = text.indexOf(q)
  if (contains >= 0) return SCORE.contains - Math.min(1_000, contains * 8 + text.length)
  const fuzzy = subsequenceScore(q, text)
  if (fuzzy > 0) return SCORE.subsequence + fuzzy
  for (const keyword of keywords) {
    const key = keyword.toLowerCase()
    if (key === q) return SCORE.keyword
    if (key.startsWith(q)) return SCORE.keyword - 100
    if (key.includes(q)) return SCORE.keyword - 200
  }
  return 0
}

export function filterQuickPick<T>(items: QuickPickItem<T>[], query: string, limit = 100): QuickPickItem<T>[] {
  const scored = items
    .map((item, index) => ({ item, index, score: scoreQuery(query, item.label, item.keywords) }))
    .filter((entry) => entry.score > 0)
  // 同分保持原始顺序（稳定排序）：菜单顺序本身有语义（如 tab 从左到右）
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored.slice(0, limit).map((entry) => entry.item)
}

export interface GotoLineTarget {
  line: number
  column: number
}

// 支持 `12`、`:12`、`12:5`（第 12 行第 5 列），其余一律视为无效输入，
// 让调用方保留上一次输入而不是跳到奇怪的位置
export function parseGotoLine(input: string, lineCount: number): GotoLineTarget | null {
  const text = input.trim().replace(/^:/, '')
  if (!text) return null
  const match = /^(\d+)(?::(\d+))?$/.exec(text)
  if (!match) return null
  const line = Number(match[1])
  const column = match[2] ? Number(match[2]) : 1
  if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) return null
  const maxLine = Math.max(1, lineCount)
  return { line: Math.min(line, maxLine), column: Math.max(1, column) }
}

export function nextIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return 0
  return ((current + delta) % length + length) % length
}
