// 轻量符号大纲：不接 LSP（见 docs/ROADMAP.md 的边界），用按语言的行级模式 + 缩进
// 推断作用域。目标是「面包屑 + Ctrl+Shift+O 够用」，不是语义精确的 AST。
//
// 约定：
// - 单趟扫描，超长行直接跳过（压缩/生成文件的长行对大纲无意义且拖慢正则）
// - depth 由行首缩进列数换算（制表符按 1 列），用于面包屑的祖先链
// - 上限 maxLines/maxSymbols 保证大文件下仍是毫秒级
export type EditorSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'enum'
  | 'type'
  | 'const'
  | 'variable'
  | 'heading'
  | 'key'
  | 'section'
  | 'module'
  | 'struct'
  | 'trait'

export interface EditorSymbol {
  name: string
  kind: EditorSymbolKind
  line: number
  column: number
  // 缩进层级（0 = 顶层），用于祖先链与大纲缩进
  depth: number
  detail?: string
}

export interface OutlineOptions {
  maxLines?: number
  maxSymbols?: number
  maxLineLength?: number
}

export const OUTLINE_LIMITS = { maxLines: 20000, maxSymbols: 500, maxLineLength: 4000 }

interface SymbolRule {
  pattern: RegExp
  kind: EditorSymbolKind
  // 'heading' 用 # 数量推深度，'indent' 用行首缩进，'flat' 一律 depth 0
  depth?: 'heading' | 'indent' | 'flat'
  // 捕获组序号：1 = 名称
  nameGroup?: number
}

const TS_RULES: SymbolRule[] = [
  { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, kind: 'function' },
  { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/, kind: 'class' },
  { pattern: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([\w$]+)/, kind: 'interface' },
  { pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)/, kind: 'enum' },
  { pattern: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*[=<]/, kind: 'type' },
  // 箭头函数常量：const foo = (…) => / const foo = async x => / const foo = x => …
  {
    pattern:
      /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
    kind: 'function',
  },
  // 类方法：缩进 2+ 且以 `(` 参数列表 + `{` 结束的标识符行
  {
    pattern:
      /^\s{2,}(?:(?:public|private|protected|static|async|readonly|abstract|override|get|set)\s+)*([\w$]+)\s*\([^;]*\)\s*(?::\s*[^={;]+)?\{\s*\}?\s*$/,
    kind: 'method',
  },
]

const PY_RULES: SymbolRule[] = [
  { pattern: /^(\s*)(?:async\s+)?def\s+([\w$]+)/, kind: 'function', nameGroup: 2 },
  { pattern: /^(\s*)class\s+([\w$]+)/, kind: 'class', nameGroup: 2 },
]

const GO_RULES: SymbolRule[] = [
  { pattern: /^func\s+(?:\([^)]*\)\s*)?([\w$]+)/, kind: 'function', depth: 'flat' },
  { pattern: /^type\s+([\w$]+)\s+struct/, kind: 'struct', depth: 'flat' },
  { pattern: /^type\s+([\w$]+)\s+interface/, kind: 'interface', depth: 'flat' },
]

const RUST_RULES: SymbolRule[] = [
  { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([\w$]+)/, kind: 'function', nameGroup: 2 },
  { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?struct\s+([\w$]+)/, kind: 'struct', nameGroup: 2 },
  { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?enum\s+([\w$]+)/, kind: 'enum', nameGroup: 2 },
  { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?trait\s+([\w$]+)/, kind: 'trait', nameGroup: 2 },
  { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?impl(?:<[^>]*>)?\s+(?:[\w$:<>]+\s+for\s+)?([\w$]+)/, kind: 'class', nameGroup: 2 },
  { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?mod\s+([\w$]+)/, kind: 'module', nameGroup: 2 },
]

const MD_RULES: SymbolRule[] = [{ pattern: /^(#{1,6})\s+(.+?)\s*#*\s*$/, kind: 'heading', depth: 'heading', nameGroup: 2 }]

const SH_RULES: SymbolRule[] = [{ pattern: /^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{/, kind: 'function' }]

const CSHARP_LIKE_RULES: SymbolRule[] = [
  { pattern: /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|async|\s)*class\s+([\w$]+)/, kind: 'class' },
  { pattern: /^\s*(?:public|private|protected|internal|static|final|abstract|\s)*interface\s+([\w$]+)/, kind: 'interface' },
]

const INI_RULES: SymbolRule[] = [{ pattern: /^\s*\[([^\]]+)\]/, kind: 'section', depth: 'flat' }]

const SQL_RULES: SymbolRule[] = [
  { pattern: /^\s*create\s+(?:or\s+replace\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, kind: 'section', depth: 'flat' },
  { pattern: /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([\w."]+)/i, kind: 'function', depth: 'flat' },
]

const RULES_BY_LANGUAGE: Record<string, SymbolRule[]> = {
  typescript: TS_RULES,
  javascript: TS_RULES,
  python: PY_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  markdown: MD_RULES,
  shell: SH_RULES,
  java: CSHARP_LIKE_RULES,
  kotlin: CSHARP_LIKE_RULES,
  ini: INI_RULES,
  yaml: INI_RULES,
  sql: SQL_RULES,
}

// markdown/json/yaml 额外规则：json 的顶层键、yaml 的零缩进键都按 key 收
const KEY_LANGUAGE = new Set(['json', 'yaml'])

export function getOutlineRules(language: string): SymbolRule[] {
  return RULES_BY_LANGUAGE[language] || []
}

export function isOutlineSupported(language: string): boolean {
  return !!RULES_BY_LANGUAGE[language] || KEY_LANGUAGE.has(language)
}

function indentDepth(indent: string, tabSize = 2) {
  let columns = 0
  for (const char of indent) columns += char === '\t' ? tabSize : 1
  return Math.floor(columns / tabSize)
}

export function extractOutline(language: string, content: string, options: OutlineOptions = {}): EditorSymbol[] {
  const maxLines = options.maxLines ?? OUTLINE_LIMITS.maxLines
  const maxSymbols = options.maxSymbols ?? OUTLINE_LIMITS.maxSymbols
  const maxLineLength = options.maxLineLength ?? OUTLINE_LIMITS.maxLineLength
  const rules = getOutlineRules(language)
  const allowKeys = KEY_LANGUAGE.has(language)
  if (!rules.length && !allowKeys) return []
  if (!content) return []
  const symbols: EditorSymbol[] = []
  // json 只收第 1 层键（缩进 <= 4 列），再深的键在大纲里只是噪声
  const lines = content.split('\n')
  const limit = Math.min(lines.length, maxLines)
  for (let index = 0; index < limit; index += 1) {
    if (symbols.length >= maxSymbols) break
    const raw = lines[index]
    if (!raw || raw.length > maxLineLength) continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (rules.length) {
      let matched = false
      for (const rule of rules) {
        const match = rule.pattern.exec(raw)
        if (!match) continue
        const name = (match[rule.nameGroup ?? 1] || '').trim()
        if (!name) continue
        // markdown 的标题名保留原文（可能含反引号/链接），其余语言去掉尾随标点
        const cleanName = rule.kind === 'heading' ? name : name.replace(/[(:;,]+$/, '')
        if (!cleanName) continue
        const depth =
          rule.depth === 'heading'
            ? Math.max(0, (match[1] || '#').length - 1)
            : rule.depth === 'flat'
              ? 0
              : indentDepth(raw.slice(0, raw.length - raw.trimStart().length))
        symbols.push({
          name: cleanName,
          kind: rule.kind,
          line: index + 1,
          column: raw.indexOf(trimmed) + 1,
          depth,
        })
        matched = true
        break
      }
      if (matched) continue
    }
    if (!allowKeys) continue
    const keyMatch = /^(\s*)"([^"]+)"\s*:/.exec(raw) || /^(\s*)([A-Za-z_][\w.-]*)\s*:\s*(?:$|[^:=])/.exec(raw)
    if (!keyMatch) continue
    const indent = keyMatch[1] || ''
    const depth = indentDepth(indent)
    // note: TS 的 `indentDepth` 按 2 空格一格，json 常规缩进 2 正好 1 层
    if (depth > 1) continue
    const name = keyMatch[2]
    if (!name || name.length > 120) continue
    symbols.push({ name, kind: 'key', line: index + 1, column: indent.length + 1, depth })
  }
  return symbols
}

// 光标所在符号：最后一个起始行 <= line 的符号；没有则返回 null
export function findSymbolAtLine(symbols: EditorSymbol[], line: number): EditorSymbol | null {
  let found: EditorSymbol | null = null
  for (const symbol of symbols) {
    if (symbol.line > line) break
    found = symbol
  }
  return found
}

// 祖先链：从命中符号沿缩进向上找「更浅一层的最近符号」，
// 供面包屑显示 `class Foo › method bar`
export function buildSymbolTrail(symbols: EditorSymbol[], line: number): EditorSymbol[] {
  const index = symbols.findLastIndex((symbol) => symbol.line <= line)
  if (index < 0) return []
  const trail: EditorSymbol[] = [symbols[index]]
  let depth = symbols[index].depth
  for (let cursor = index - 1; cursor >= 0 && depth > 0; cursor -= 1) {
    const candidate = symbols[cursor]
    if (candidate.depth < depth) {
      trail.unshift(candidate)
      depth = candidate.depth
    }
  }
  return trail
}
