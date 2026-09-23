'use client'
import { api } from './api'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'

type TsModule = typeof import('typescript')
type ResolveStatus = 'success' | 'not-found' | 'unsupported'
interface ResolverFile extends FileDocumentHandle {
  content: string
}
interface ResolverContext {
  hostId: string
  rootId: string
  rootLabel: string
  rootPath: string
  // 搜索结果 file.path 相对的真实 root 路径——编辑器 rootPath 可能是收藏虚拟根，不能直接 join
  searchRootPath: string
  sourceRootPath: string
  openEditors: Map<string, FileEditorDocument>
  statCache: Map<string, Promise<{ type: 'file' | 'directory'; content?: string } | null>>
  fileCache: Map<string, Promise<ResolverFile | null>>
  moduleCache: Map<string, Promise<ResolverFile | null>>
}
interface ImportBinding {
  localName: string
  importedName: string
  specifier: string
  kind: 'named' | 'default' | 'namespace'
}
export interface CodeNavigationTarget extends Omit<FileDocumentHandle, 'type'> {
  type: 'file'
  line: number
  column: number
}
export type CodeNavigationResult =
  { status: 'success'; target: CodeNavigationTarget } | { status: Exclude<ResolveStatus, 'success'> }

const SUPPORTED_LANGUAGES = new Set(['typescript', 'javascript'])
const FILE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']
// .d.ts 已被 .ts 后缀覆盖；扩展名判断用于兜底 editor.language 缺失/陈旧（持久化恢复、旧数据）的场景
const NAVIGABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const HISTORY_FILE_LIMIT = 160
const SEARCH_CONTENT_TIMEOUT_MS = 12_000
let tsPromise: Promise<TsModule> | null = null

function loadTypeScript() {
  if (!tsPromise) tsPromise = import('typescript')
  return tsPromise
}
function normalizePath(value: string) {
  const input = (value || '').replace(/\\/g, '/')
  const absolute = input.startsWith('/')
  const parts = input.split('/').filter(Boolean)
  const next: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (next.length) next.pop()
      continue
    }
    next.push(part)
  }
  return `${absolute ? '/' : ''}${next.join('/')}` || (absolute ? '/' : '.')
}
function joinPath(...parts: string[]) {
  return normalizePath(parts.filter(Boolean).join('/'))
}
function dirnamePath(value: string) {
  const normalized = normalizePath(value)
  if (normalized === '/' || normalized === '.') return normalized
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return normalized.startsWith('/') ? '/' : '.'
  return normalized.slice(0, index)
}
function basenamePath(value: string) {
  const normalized = normalizePath(value)
  if (normalized === '/' || normalized === '.') return normalized
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
function hasRootPrefix(rootPath: string, absolutePath: string) {
  const root = normalizePath(rootPath)
  const target = normalizePath(absolutePath)
  return target === root || target.startsWith(`${root}/`)
}
function toRelativePath(rootPath: string, absolutePath: string) {
  const root = normalizePath(rootPath)
  const target = normalizePath(absolutePath)
  if (!hasRootPrefix(root, target)) return null
  if (target === root) return ''
  return target.slice(root.length + 1)
}
function withFileExtension(path: string) {
  return FILE_EXTENSIONS.some((ext) => path.endsWith(ext))
}
function toScriptExtension(ts: TsModule, path: string) {
  const lower = normalizePath(path).toLowerCase()
  if (lower.endsWith('.d.ts')) return ts.Extension.Dts
  if (lower.endsWith('.tsx')) return ts.Extension.Tsx
  if (lower.endsWith('.ts')) return ts.Extension.Ts
  if (lower.endsWith('.jsx')) return ts.Extension.Jsx
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.Extension.Js
  if (lower.endsWith('.json')) return ts.Extension.Json
  return ts.Extension.Ts
}
function toScriptKind(ts: TsModule, path: string) {
  const lower = normalizePath(path).toLowerCase()
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (lower.endsWith('.ts') || lower.endsWith('.d.ts') || lower.endsWith('.mts') || lower.endsWith('.cts'))
    return ts.ScriptKind.TS
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (lower.endsWith('.json')) return ts.ScriptKind.JSON
  return ts.ScriptKind.JS
}
function getOffset(content: string, line: number, column: number) {
  const nextLine = Math.max(1, line)
  const nextColumn = Math.max(1, column)
  let currentLine = 1
  let currentColumn = 1
  for (let index = 0; index < content.length; index += 1) {
    if (currentLine === nextLine && currentColumn === nextColumn) return index
    const char = content[index]
    if (char === '\n') {
      currentLine += 1
      currentColumn = 1
      if (currentLine > nextLine) return index + 1
      continue
    }
    currentColumn += 1
  }
  return content.length
}
function findNodeAtPosition(
  ts: TsModule,
  sourceFile: import('typescript').SourceFile,
  position: number,
): import('typescript').Node | null {
  // 显式返回标注：target 在嵌套 visit 闭包内赋值，TS 会把 return 的推断类型收窄成 null，
  // 不标注则调用点拿到 null 类型，后续属性访问全部变 never
  let target: import('typescript').Node | null = null
  const visit = (node: import('typescript').Node) => {
    if (position < node.getFullStart() || position >= node.getEnd()) return
    target = node
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return target
}
function hasModifier(ts: TsModule, node: import('typescript').Node, kind: import('typescript').SyntaxKind) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return !!modifiers?.some((modifier) => modifier.kind === kind)
}
function collectImportBindings(ts: TsModule, sourceFile: import('typescript').SourceFile) {
  const bindings = new Map<string, ImportBinding>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    )
      continue
    const specifier = statement.moduleSpecifier.text
    if (statement.importClause.name)
      bindings.set(statement.importClause.name.text, {
        localName: statement.importClause.name.text,
        importedName: 'default',
        specifier,
        kind: 'default',
      })
    const namedBindings = statement.importClause.namedBindings
    if (!namedBindings) continue
    if (ts.isNamespaceImport(namedBindings)) {
      bindings.set(namedBindings.name.text, {
        localName: namedBindings.name.text,
        importedName: '*',
        specifier,
        kind: 'namespace',
      })
      continue
    }
    for (const element of namedBindings.elements) {
      bindings.set(element.name.text, {
        localName: element.name.text,
        importedName: element.propertyName?.text || element.name.text,
        specifier,
        kind: 'named',
      })
    }
  }
  return bindings
}
function findLocalDeclarationByName(ts: TsModule, sourceFile: import('typescript').SourceFile, name: string) {
  let target: import('typescript').Node | null = null
  const visit = (node: import('typescript').Node) => {
    if (target) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      target = node.name
      return
    }
    // import 绑定不在此命中：import 进来的符号由 resolveExportedSymbol 沿 import 源继续追，
    // 返回 specifier 会把 barrel 的 import 行误当真实声明
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isBindingElement(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      target = node.name
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return target
}
interface ExportedSymbolHit {
  file: ResolverFile
  sourceFile: import('typescript').SourceFile
  node: import('typescript').Node
}
// 沿导出链追到真实声明：named/star re-export、export 别名、import 后再 export、
// `export default <identifier>` 都继续向下解析。seen 按「文件+kind+符号」去重，
// 保证循环 re-export 终止；signal 取消即停。找不到返回 null，由调用方决定失败语义
async function resolveExportedSymbol(
  ts: TsModule,
  context: ResolverContext,
  file: ResolverFile,
  importedName: string,
  kind: ImportBinding['kind'],
  seen: Set<string>,
  signal?: AbortSignal,
): Promise<ExportedSymbolHit | null> {
  const key = `${normalizePath(file.absolutePath)}:${kind}:${importedName}`
  if (signal?.aborted || seen.has(key)) return null
  seen.add(key)
  const sourceFile = ts.createSourceFile(
    file.absolutePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    toScriptKind(ts, file.absolutePath),
  )
  if (kind === 'namespace') return { file, sourceFile, node: sourceFile }
  const bindings = collectImportBindings(ts, sourceFile)
  const follow = async (specifier: string, name: string, nextKind: ImportBinding['kind']) => {
    const next = await resolveModuleSpecifier(context, file.absolutePath, specifier)
    return next ? resolveExportedSymbol(ts, context, next, name, nextKind, seen, signal) : null
  }
  // 本地名解析：来自 import 的符号继续追 import 源（import 后再 export），否则取本地声明
  const resolveLocal = async (localName: string): Promise<ExportedSymbolHit | null> => {
    const binding = bindings.get(localName)
    if (binding) return follow(binding.specifier, binding.importedName, binding.kind)
    const node = findLocalDeclarationByName(ts, sourceFile, localName)
    return node ? { file, sourceFile, node } : null
  }
  if (kind === 'default') {
    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement)) {
        // export default foo / export = foo：标识符只是引用，须落到其真实声明
        if (ts.isIdentifier(statement.expression)) {
          const hit = await resolveLocal(statement.expression.text)
          if (hit) return hit
        }
        return { file, sourceFile, node: statement.expression }
      }
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword) &&
        hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)
      )
        return { file, sourceFile, node: statement.name || statement }
    }
  }
  // default 查找对应名为 default 的具名导出（export { x as default }）
  const lookupName = kind === 'default' ? 'default' : importedName
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.exportClause)
        continue
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== lookupName) continue
          // export { a as b } from './m'：导出名 b 命中后追到 ./m 里的原名 a
          const nextName = element.propertyName?.text || element.name.text
          const hit = await follow(
            statement.moduleSpecifier.text,
            nextName,
            nextName === 'default' ? 'default' : 'named',
          )
          if (hit) return hit
        }
      } else if (statement.exportClause.name.text === lookupName) {
        // export * as ns from './m'：等价于把整模块作为 ns 导出
        const hit = await follow(statement.moduleSpecifier.text, '*', 'namespace')
        if (hit) return hit
      }
      continue
    }
    if (!hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) continue
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === lookupName
    )
      return { file, sourceFile, node: statement.name }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === lookupName)
          return { file, sourceFile, node: declaration.name }
      }
    }
  }
  // export { foo }（无 moduleSpecifier）：本地名可能来自 import（继续追）或本地声明
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== lookupName) continue
      const hit = await resolveLocal(element.propertyName?.text || element.name.text)
      if (hit) return hit
    }
  }
  // export * 最后走：本地具名导出与具名 re-export 语义上优先于星号转发；default 不经 export * 转发
  if (kind !== 'default') {
    for (const statement of sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.exportClause ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteralLike(statement.moduleSpecifier)
      )
        continue
      const hit = await follow(statement.moduleSpecifier.text, importedName, kind)
      if (hit) return hit
    }
  }
  return resolveLocal(lookupName)
}
function isBareSpecifier(value: string) {
  return value !== '' && !value.startsWith('.') && !value.startsWith('/')
}
function parsePackageSpecifier(value: string) {
  if (value.startsWith('@')) {
    const parts = value.split('/')
    if (parts.length < 2) return { packageName: value, subpath: '' }
    return { packageName: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join('/') }
  }
  const [packageName, ...rest] = value.split('/')
  return { packageName, subpath: rest.join('/') }
}
function readExportTarget(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = readExportTarget(item)
      if (resolved.length) return resolved
    }
    return []
  }
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of ['types', 'import', 'default', 'require', 'node']) {
    const resolved = readExportTarget(record[key])
    if (resolved.length) return resolved
  }
  for (const item of Object.values(record)) {
    const resolved = readExportTarget(item)
    if (resolved.length) return resolved
  }
  return []
}
async function readStat(context: ResolverContext, absolutePath: string) {
  const normalized = normalizePath(absolutePath)
  if (!hasRootPrefix(context.rootPath, normalized)) return null
  const cached = context.statCache.get(normalized)
  if (cached) return cached
  const promise = (async () => {
    const relativePath = toRelativePath(context.rootPath, normalized)
    if (relativePath == null) return null
    try {
      const result = await api.files.content(context.hostId, context.rootId, relativePath)
      if (result.type === 'directory') return { type: 'directory' as const }
      if (result.type !== 'file') return null
      return result.binary || result.truncated
        ? { type: 'file' as const }
        : { type: 'file' as const, content: result.content }
    } catch {
      return null
    }
  })()
  context.statCache.set(normalized, promise)
  return promise
}
async function readResolverFile(context: ResolverContext, absolutePath: string) {
  const normalized = normalizePath(absolutePath)
  const existing = context.fileCache.get(normalized)
  if (existing) return existing
  const promise = (async () => {
    if (!hasRootPrefix(context.rootPath, normalized)) return null
    const relativePath = toRelativePath(context.rootPath, normalized)
    if (relativePath == null) return null
    const openEditor = context.openEditors.get(normalized)
    if (openEditor && !openEditor.loading && !openEditor.binary && !openEditor.truncated && !openEditor.problem) {
      return {
        id: openEditor.id,
        hostId: openEditor.hostId,
        rootId: openEditor.rootId,
        rootLabel: openEditor.rootLabel,
        rootPath: openEditor.rootPath,
        path: openEditor.path,
        name: openEditor.name,
        absolutePath: normalized,
        type: 'file',
        content: openEditor.content,
      } satisfies ResolverFile
    }
    const stat = await readStat(context, normalized)
    if (!stat || stat.type !== 'file' || typeof stat.content !== 'string') return null
    return {
      id: `${context.hostId}:${context.rootId}:${relativePath}`,
      hostId: context.hostId,
      rootId: context.rootId,
      rootLabel: context.rootLabel,
      rootPath: context.rootPath,
      path: relativePath,
      name: basenamePath(normalized),
      absolutePath: normalized,
      type: 'file',
      content: stat.content,
    } satisfies ResolverFile
  })()
  context.fileCache.set(normalized, promise)
  return promise
}
async function resolveFileCandidate(context: ResolverContext, absolutePath: string) {
  const normalized = normalizePath(absolutePath)
  if (withFileExtension(normalized)) {
    const direct = await readResolverFile(context, normalized)
    if (direct) return direct
  } else {
    for (const ext of FILE_EXTENSIONS) {
      const withExt = await readResolverFile(context, `${normalized}${ext}`)
      if (withExt) return withExt
    }
    const direct = await readResolverFile(context, normalized)
    if (direct) return direct
  }
  for (const ext of FILE_EXTENSIONS) {
    const indexFile = await readResolverFile(context, joinPath(normalized, `index${ext}`))
    if (indexFile) return indexFile
  }
  return null
}
async function resolvePackageEntry(context: ResolverContext, packageDir: string, subpath: string) {
  const normalizedPackageDir = normalizePath(packageDir)
  if (subpath) {
    const direct = await resolveFileCandidate(context, joinPath(normalizedPackageDir, subpath))
    if (direct) return direct
  }
  const packageJson = await readResolverFile(context, joinPath(normalizedPackageDir, 'package.json'))
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson.content) as {
        types?: string
        typings?: string
        module?: string
        main?: string
        exports?: unknown
      }
      const exportKey = subpath ? `./${subpath}` : '.'
      const exportsValue = subpath
        ? parsed.exports && typeof parsed.exports === 'object' && !Array.isArray(parsed.exports)
          ? (parsed.exports as Record<string, unknown>)[exportKey]
          : undefined
        : parsed.exports
      for (const candidate of [
        ...readExportTarget(exportsValue),
        parsed.types || '',
        parsed.typings || '',
        parsed.module || '',
        parsed.main || '',
      ]) {
        if (!candidate) continue
        const resolved = await resolveFileCandidate(context, joinPath(normalizedPackageDir, candidate))
        if (resolved) return resolved
      }
    } catch {}
  }
  return resolveFileCandidate(context, joinPath(normalizedPackageDir, subpath))
}
async function resolveModuleSpecifier(context: ResolverContext, absolutePath: string, specifier: string) {
  const normalizedAbsolutePath = normalizePath(absolutePath)
  const cacheKey = `${normalizedAbsolutePath}::${specifier}`
  const existing = context.moduleCache.get(cacheKey)
  if (existing) return existing
  const promise = (async () => {
    if (!specifier) return null
    if (specifier.startsWith('@/'))
      return resolveFileCandidate(context, joinPath(context.sourceRootPath, specifier.slice(2)))
    if (!isBareSpecifier(specifier))
      return resolveFileCandidate(context, joinPath(dirnamePath(normalizedAbsolutePath), specifier))
    const { packageName, subpath } = parsePackageSpecifier(specifier)
    let current = dirnamePath(normalizedAbsolutePath)
    while (hasRootPrefix(context.rootPath, current)) {
      const resolved = await resolvePackageEntry(context, joinPath(current, 'node_modules', packageName), subpath)
      if (resolved) return resolved
      if (current === normalizePath(context.rootPath) || current === '/') break
      current = dirnamePath(current)
    }
    return null
  })()
  context.moduleCache.set(cacheKey, promise)
  return promise
}
function collectModuleSpecifiers(ts: TsModule, sourceFile: import('typescript').SourceFile) {
  const specifiers = new Set<string>()
  const visit = (node: import('typescript').Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
        specifiers.add(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return Array.from(specifiers)
}
async function buildProjectGraph(ts: TsModule, context: ResolverContext, entryFile: ResolverFile) {
  const loaded = new Map<string, ResolverFile>()
  const queue = [entryFile]
  while (queue.length && loaded.size < HISTORY_FILE_LIMIT) {
    const current = queue.shift()
    if (!current) break
    const normalized = normalizePath(current.absolutePath)
    if (loaded.has(normalized)) continue
    loaded.set(normalized, current)
    const sourceFile = ts.createSourceFile(
      normalized,
      current.content,
      ts.ScriptTarget.Latest,
      true,
      toScriptKind(ts, normalized),
    )
    for (const specifier of collectModuleSpecifiers(ts, sourceFile)) {
      const resolved = await resolveModuleSpecifier(context, normalized, specifier)
      if (resolved && !loaded.has(normalizePath(resolved.absolutePath))) queue.push(resolved)
    }
  }
  return loaded
}
async function getResolvedModules(context: ResolverContext, containingFile: string, moduleNames: string[]) {
  const resolved = await Promise.all(
    moduleNames.map((moduleName) => resolveModuleSpecifier(context, containingFile, moduleName)),
  )
  return new Map(moduleNames.map((moduleName, index) => [moduleName, resolved[index] || null]))
}
function isNavigableFileName(name: string) {
  const lower = (name || '').toLowerCase()
  return NAVIGABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
function escapeRegExpText(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// 非 TS/JS 语言的兜底定义跳转：按置信度排列的模式匹配（关键字定义 → 带返回类型 → 裸 name( → 标注/赋值）
const GENERIC_DEFINITION_MODIFIERS =
  '(?:export|default|async|public|private|protected|static|final|abstract|override|open|virtual|inline|constexpr|extern|mut|unsafe|internal|pub|readonly|declare|global)\\s+'
function buildGenericDefinitionPatterns(word: string) {
  const escaped = escapeRegExpText(word)
  return [
    // def foo( / function foo( / func (r *T) foo( / class Foo / const foo —— 关键字 + 可选接收者
    new RegExp(
      `^\\s*(?:${GENERIC_DEFINITION_MODIFIERS})*(?:def|function|func|fn|fun|class|interface|struct|enum|union|trait|impl|type|typedef|namespace|module|mod|sub|proc|procedure|macro|const|let|var|val|local)\\s+(?:\\([^()]*\\)\\s*)?${escaped}\\b`,
    ),
    // int foo( / public static String foo( —— 带返回类型的 C/Java 系定义
    new RegExp(`^\\s*(?:${GENERIC_DEFINITION_MODIFIERS})*(?:[\\w.<>\\[\\]*&?]+\\s+)+${escaped}\\s*\\(`),
    // foo( / foo () { —— shell 函数、K&R C、类方法
    new RegExp(`^\\s*${escaped}\\s*\\(`),
    // foo: / foo := —— 类型标注、Go 短变量声明
    new RegExp(`^\\s*${escaped}\\s*:`),
    // foo = / foo: T = —— 顶层赋值（排除 ==、=>）
    new RegExp(`^\\s*${escaped}\\s*(?::[^=\\n]+)?=(?![=>])`),
  ]
}
function extractWordAtPosition(content: string, line: number, column: number) {
  const lineText = content.split(/\r?\n/)[Math.max(0, line - 1)] || ''
  const index = Math.min(Math.max(0, column - 1), lineText.length)
  const isWordChar = (char: string) => /[\p{L}\p{N}_$]/u.test(char)
  let start = index
  let end = index
  while (start > 0 && isWordChar(lineText[start - 1])) start -= 1
  while (end < lineText.length && isWordChar(lineText[end])) end += 1
  const word = lineText.slice(start, end)
  return word && /[\p{L}_$]/u.test(word[0]) ? word : null
}
// Python 式 import 感知：from a.b import word / import a.b.word —— 把符号映射回模块路径，
// 同名 def 在同目录多个文件里时（如 val_2D.py 与 test_2D_fully.py 都定义 test_single_volume）按模块名定胜负
interface ModuleHint {
  // PEP 328：前导点单独计数，N 个点 = 从入口文件目录向上 N-1 层；0 = 绝对 import。
  // 不能混进 modulePath（'.→/' 会把 ..pkg 转成 //pkg 被 normalize 成 pkg，语义错误）
  levels: number
  // 去掉前导点后的模块路径（'/' 分隔）；from . import x 时为空串（目标即入口所在包）
  modulePath: string
  // true: word 是模块成员（from a.b import word → 在模块文件里找 word 定义）；
  // false: word 是模块本身（import a.b / from a.b import 子模块 → 跳到文件顶部）
  member: boolean
}
function extractImportModuleHints(content: string, word: string) {
  const hints = new Map<string, ModuleHint>()
  const push = (hint: ModuleHint) => hints.set(`${hint.levels}:${hint.modulePath}:${hint.member}`, hint)
  const fromRe = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(\([\s\S]*?\)|[^#\n(]*)/gm
  for (const match of content.matchAll(fromRe)) {
    const levels = match[1].length
    const modulePath = match[2].replace(/\./g, '/')
    const names = match[3]
      .replace(/[()\\]/g, ' ')
      .split(/[\s,]+/)
      .map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
    if (!names.includes(word)) continue
    // from a.b import c：c 可能是 a/b.py 内的符号（member），也可能是子模块 a/b/c.py —— 两种都提示
    push({ levels, modulePath, member: true })
    push({ levels, modulePath: modulePath ? `${modulePath}/${word}` : word, member: false })
  }
  const importRe = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm
  for (const match of content.matchAll(importRe)) {
    const parts = match[1].split('.')
    if (match[2] === word || parts[parts.length - 1] === word)
      push({ levels: 0, modulePath: parts.join('/'), member: false })
  }
  return [...hints.values()]
}
function moduleHintScore(path: string, hints: ModuleHint[]) {
  if (!hints.length) return 0
  const noExt = path.replace(/\.[^./]+$/, '')
  return hints.some((hint) => hint.modulePath && (noExt === hint.modulePath || noExt.endsWith(`/${hint.modulePath}`)))
    ? 1
    : 0
}
// 与入口文件目录共享的路径段数：跨文件候选按邻近度降序，兄弟目录 > 其它 worktree
function sharedDirectoryDepth(entryDir: string, filePath: string) {
  const entry = entryDir.split('/').filter(Boolean)
  const candidate = dirnamePath(filePath).split('/').filter(Boolean)
  let depth = 0
  while (depth < entry.length && depth < candidate.length && entry[depth] === candidate[depth]) depth += 1
  return depth
}
function wordColumn(lineText: string, word: string) {
  const match = new RegExp(`\\b${escapeRegExpText(word)}\\b`).exec(lineText)
  return match ? match.index + 1 : 1
}
function findGenericDefinition(content: string, word: string, excludeLine: number) {
  const lines = content.split(/\r?\n/)
  for (const pattern of buildGenericDefinitionPatterns(word)) {
    let selfHit: { line: number; column: number } | null = null
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index])) continue
      const hit = { line: index + 1, column: wordColumn(lines[index], word) }
      if (index + 1 === excludeLine) {
        // 光标就在定义行：记录后跳过，优先返回其它匹配；无其它匹配才返回自身（原地跳）
        if (!selfHit) selfHit = hit
        continue
      }
      return hit
    }
    if (selfHit) return selfHit
  }
  return null
}
function ascendDir(dir: string, levels: number) {
  let current = dir
  for (let i = 0; i < levels; i += 1) current = dirnamePath(current)
  return current
}
// import 直解快速路径：把 module 提示在入口目录向上 3 级（root 内）映射成 *.py / __init__.py 直接读取，
// 命中即零 rg 调用（<100ms）—— Python 跳转的主场景就是跳 import 进来的符号
async function resolvePythonImport(
  context: ResolverContext,
  entryFile: ResolverFile,
  word: string,
  hints: ModuleHint[],
  signal?: AbortSignal,
): Promise<{ file: ResolverFile; line: number; column: number } | null> {
  const entryDir = dirnamePath(entryFile.absolutePath)
  const rootPath = normalizePath(context.rootPath)
  // 绝对 import 的基准目录序列：入口目录 + 向上最多 3 级，近似 sys.path 的就近命中（同包/父包优先）
  const absoluteBases: string[] = []
  for (let dir = entryDir; absoluteBases.length < 4 && hasRootPrefix(rootPath, dir); dir = dirnamePath(dir)) {
    absoluteBases.push(dir)
    if (dir === '/' || dir === rootPath) break
  }
  for (const hint of hints) {
    const bases =
      hint.levels > 0
        ? [ascendDir(entryDir, hint.levels - 1)].filter((dir) => hasRootPrefix(rootPath, dir))
        : absoluteBases
    for (const base of bases) {
      if (signal?.aborted) return null
      const moduleBase = hint.modulePath ? joinPath(base, hint.modulePath) : base
      // member: 模块文件内找 word 定义；非 member: word 即模块，跳到文件顶部
      const candidates = hint.member
        ? [...(hint.modulePath ? [`${moduleBase}.py`] : []), joinPath(moduleBase, '__init__.py')].map((path) => ({
            path,
            member: true,
          }))
        : [`${moduleBase}.py`, joinPath(moduleBase, '__init__.py')].map((path) => ({ path, member: false }))
      for (const candidate of candidates) {
        const file = await readResolverFile(context, candidate.path)
        if (!file) continue
        if (!candidate.member) return { file, line: 1, column: 1 }
        const hit = findGenericDefinition(file.content, word, -1)
        if (hit) return { file, line: hit.line, column: hit.column }
      }
    }
  }
  return null
}
async function resolveGenericDefinition(
  context: ResolverContext,
  entryFile: ResolverFile,
  position: { line: number; column: number },
  signal?: AbortSignal,
): Promise<CodeNavigationResult> {
  const word = extractWordAtPosition(entryFile.content, position.line, position.column)
  if (!word) return { status: 'not-found' }
  const toTarget = (file: FileDocumentHandle, hit: { line: number; column: number }): CodeNavigationResult => ({
    status: 'success',
    target: {
      id: file.id,
      hostId: file.hostId,
      rootId: file.rootId,
      rootLabel: file.rootLabel,
      rootPath: file.rootPath,
      path: file.path,
      name: file.name,
      absolutePath: file.absolutePath,
      type: 'file',
      line: hit.line,
      column: hit.column,
    },
  })
  const local = findGenericDefinition(entryFile.content, word, position.line)
  if (local) return toTarget(entryFile, local)
  // 已打开编辑器的内容（含未保存修改）优先于远端搜索
  for (const openEditor of context.openEditors.values()) {
    if (normalizePath(openEditor.absolutePath) === entryFile.absolutePath) continue
    if (openEditor.kind === 'compare' || openEditor.binary || openEditor.truncated || !openEditor.content) continue
    const hit = findGenericDefinition(openEditor.content, word, -1)
    if (hit) return toTarget(openEditor, hit)
  }
  // import 直解：module 提示映射到具体文件读内容定位，命中则完全不跑 rg（慢搜索根源）
  const moduleHints = extractImportModuleHints(entryFile.content, word)
  if (moduleHints.length && !signal?.aborted) {
    const importHit = await resolvePythonImport(context, entryFile, word, moduleHints, signal)
    if (importHit) return toTarget(importHit.file, importHit)
  }
  // 跨文件搜索先限定入口文件所在子树，再退回整 root：
  // 1) 大 root（如整个 ~）全量内容搜索可达分钟级，期间导航互斥锁会静默吞掉后续点击
  // 2) 多 worktree/同名模块下按搜索返回序取首条会跳错目录，同子树优先也更贴近脚本式 import 语义
  // 兜底范围序列：入口目录逐级后退最多 3 级（去重），首个命中即返回；全部落空才整 root
  const entryDir = dirnamePath(entryFile.path)
  const scopes: string[] = []
  for (let dir = entryDir, depth = 0; depth <= 3 && dir && dir !== '.'; depth += 1, dir = dirnamePath(dir)) {
    if (!scopes.includes(dir)) scopes.push(dir)
  }
  scopes.push('')
  const patterns = buildGenericDefinitionPatterns(word)
  // 按入口扩展名收窄 rg 扫描面（.py 只扫 *.py），进一步压缩大 root 下的搜索耗时
  const entryExt = /\.[^./]+$/.exec(entryFile.name || basenamePath(entryFile.absolutePath))?.[0]
  for (const basePath of scopes) {
    if (signal?.aborted) return { status: 'not-found' }
    let results: Awaited<ReturnType<typeof api.files.searchContent>>
    try {
      results = await api.files.searchContent(
        context.hostId,
        context.rootId,
        word,
        basePath,
        true,
        // 外部取消（用户发起新一次跳转）与单请求 12s 超时合并为一个 signal
        signal
          ? AbortSignal.any([AbortSignal.timeout(SEARCH_CONTENT_TIMEOUT_MS), signal])
          : AbortSignal.timeout(SEARCH_CONTENT_TIMEOUT_MS),
        entryExt,
      )
    } catch {
      if (signal?.aborted) return { status: 'not-found' }
      continue
    }
    const candidates = results
      .filter(
        (file) =>
          file.type === 'file' && normalizePath(joinPath(context.searchRootPath, file.path)) !== entryFile.absolutePath,
      )
      .sort(
        (a, b) =>
          moduleHintScore(b.path, moduleHints) - moduleHintScore(a.path, moduleHints) ||
          sharedDirectoryDepth(entryDir, b.path) - sharedDirectoryDepth(entryDir, a.path),
      )
    for (const pattern of patterns) {
      for (const file of candidates) {
        const absolutePath = joinPath(context.searchRootPath, file.path)
        for (const match of file.matches || []) {
          if (!pattern.test(match.content)) continue
          return toTarget(
            {
              id: `${context.hostId}:${context.rootId}:${file.path}`,
              hostId: context.hostId,
              rootId: context.rootId,
              rootLabel: context.rootLabel,
              rootPath: context.rootPath,
              path: file.path,
              name: file.name || basenamePath(file.path),
              absolutePath,
              type: 'file',
            },
            { line: match.number, column: wordColumn(match.content, word) },
          )
        }
      }
    }
  }
  return { status: 'not-found' }
}
export async function resolveEditorDefinition(
  editor: FileEditorDocument,
  position: { line: number; column: number },
  openEditors: FileEditorDocument[],
  signal?: AbortSignal,
): Promise<CodeNavigationResult> {
  const openEditorMap = new Map(openEditors.map((item) => [normalizePath(item.absolutePath), item] as const))
  openEditorMap.set(normalizePath(editor.absolutePath), editor)
  const normalizedAbs = normalizePath(editor.absolutePath)
  const normalizedRel = normalizePath(editor.path)
  const context: ResolverContext = {
    hostId: editor.hostId,
    rootId: editor.rootId,
    rootLabel: editor.rootLabel,
    rootPath: normalizePath(editor.rootPath),
    searchRootPath: normalizedAbs.endsWith(`/${normalizedRel}`)
      ? normalizedAbs.slice(0, normalizedAbs.length - normalizedRel.length - 1)
      : normalizePath(editor.rootPath),
    sourceRootPath: joinPath(editor.rootPath, 'src'),
    openEditors: openEditorMap,
    statCache: new Map(),
    fileCache: new Map(),
    moduleCache: new Map(),
  }
  const entryFile = await readResolverFile(context, editor.absolutePath)
  if (!entryFile) return { status: 'not-found' }
  const tsNavigable =
    SUPPORTED_LANGUAGES.has(editor.language) || isNavigableFileName(editor.name || editor.path || editor.absolutePath)
  if (!tsNavigable) return resolveGenericDefinition(context, entryFile, position, signal)
  const ts = await loadTypeScript()
  const entrySourceFile = ts.createSourceFile(
    entryFile.absolutePath,
    entryFile.content,
    ts.ScriptTarget.Latest,
    true,
    toScriptKind(ts, entryFile.absolutePath),
  )
  const offset = getOffset(entryFile.content, position.line, position.column)
  const importBindings = collectImportBindings(ts, entrySourceFile)
  const nodeAtPosition = findNodeAtPosition(ts, entrySourceFile, offset)
  if (nodeAtPosition) {
    if (ts.isStringLiteralLike(nodeAtPosition)) {
      const stringLiteral = nodeAtPosition as import('typescript').StringLiteralLike
      const resolvedFile = await resolveModuleSpecifier(context, entryFile.absolutePath, stringLiteral.text)
      if (resolvedFile) {
        return {
          status: 'success',
          target: {
            id: resolvedFile.id,
            hostId: resolvedFile.hostId,
            rootId: resolvedFile.rootId,
            rootLabel: resolvedFile.rootLabel,
            rootPath: resolvedFile.rootPath,
            path: toRelativePath(context.rootPath, resolvedFile.absolutePath) || resolvedFile.path,
            name: resolvedFile.name,
            absolutePath: resolvedFile.absolutePath,
            type: 'file',
            line: 1,
            column: 1,
          },
        }
      }
    }
    if (ts.isIdentifier(nodeAtPosition)) {
      const identifier = nodeAtPosition as import('typescript').Identifier
      const binding = importBindings.get(identifier.text)
      if (binding) {
        const resolvedFile = await resolveModuleSpecifier(context, entryFile.absolutePath, binding.specifier)
        // 快捷路径只有命中真实声明才返回 success；落空交给下方语义解析兜底，
        // 严禁旧逻辑 targetNode||0 把「模块找到了但符号没找到」伪装成 1:1 成功
        const hit = resolvedFile
          ? await resolveExportedSymbol(
              ts,
              context,
              resolvedFile,
              binding.importedName,
              binding.kind,
              new Set(),
              signal,
            )
          : null
        if (hit) {
          const location = ts.getLineAndCharacterOfPosition(hit.sourceFile, hit.node.getStart(hit.sourceFile, false))
          return {
            status: 'success',
            target: {
              id: hit.file.id,
              hostId: hit.file.hostId,
              rootId: hit.file.rootId,
              rootLabel: hit.file.rootLabel,
              rootPath: hit.file.rootPath,
              path: toRelativePath(context.rootPath, hit.file.absolutePath) || hit.file.path,
              name: hit.file.name,
              absolutePath: hit.file.absolutePath,
              type: 'file',
              line: location.line + 1,
              column: location.character + 1,
            },
          }
        }
      }
    }
  }
  const loadedFiles = await buildProjectGraph(ts, context, entryFile)
  const moduleNames = new Map<string, string[]>()
  for (const [fileName, file] of Array.from(loadedFiles.entries())) {
    const sourceFile = ts.createSourceFile(
      fileName,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      toScriptKind(ts, fileName),
    )
    moduleNames.set(fileName, collectModuleSpecifiers(ts, sourceFile))
  }
  const moduleResolutionMap = new Map<string, Map<string, ResolverFile | null>>()
  for (const [fileName, specs] of Array.from(moduleNames.entries())) {
    moduleResolutionMap.set(fileName, await getResolvedModules(context, fileName, specs))
  }
  const fileNames = Array.from(loadedFiles.keys())
  const compilerOptions: import('typescript').CompilerOptions = {
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    noLib: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  }
  const host: import('typescript').LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const file = loadedFiles.get(normalizePath(fileName))
      return file ? ts.ScriptSnapshot.fromString(file.content) : undefined
    },
    getCurrentDirectory: () => dirnamePath(entryFile.absolutePath),
    getDefaultLibFileName: () => 'lib.d.ts',
    fileExists: (fileName) => loadedFiles.has(normalizePath(fileName)),
    readFile: (fileName) => loadedFiles.get(normalizePath(fileName))?.content,
    readDirectory: () => [],
    directoryExists: (directoryName) => {
      const normalized = normalizePath(directoryName)
      return fileNames.some((fileName) => fileName === normalized || fileName.startsWith(`${normalized}/`))
    },
    getScriptKind: (fileName) => toScriptKind(ts, fileName),
    resolveModuleNames: (names, containingFile) =>
      names.map((name) => {
        const match = moduleResolutionMap.get(normalizePath(containingFile))?.get(name)
        if (!match) return undefined
        return {
          resolvedFileName: match.absolutePath,
          extension: toScriptExtension(ts, match.absolutePath),
          isExternalLibraryImport: match.absolutePath.includes('/node_modules/'),
        }
      }),
  }
  const service = ts.createLanguageService(host)
  const program = service.getProgram()
  let targetFile: ResolverFile | null = null
  let targetStart = 0
  if (program) {
    const sourceFile = program.getSourceFile(entryFile.absolutePath)
    const checker = program.getTypeChecker()
    if (sourceFile) {
      const node = findNodeAtPosition(ts, sourceFile, offset)
      let symbol = node ? checker.getSymbolAtLocation(node) : undefined
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
      const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0]
      if (declaration) {
        const declarationFile = declaration.getSourceFile()
        targetFile =
          loadedFiles.get(normalizePath(declarationFile.fileName)) ||
          (await resolveFileCandidate(context, declarationFile.fileName)) ||
          (await readResolverFile(context, declarationFile.fileName))
        targetStart = declaration.getStart(declarationFile, false)
      }
    }
  }
  if (!targetFile) {
    const definitions = service.getDefinitionAtPosition(entryFile.absolutePath, offset) || []
    const target = definitions[0]
    if (target) {
      targetFile =
        loadedFiles.get(normalizePath(target.fileName)) ||
        (await resolveFileCandidate(context, target.fileName)) ||
        (await readResolverFile(context, target.fileName))
      targetStart = target.textSpan.start
    }
  }
  service.dispose()
  if (!targetFile) return { status: 'not-found' }
  let sourceFile = ts.createSourceFile(
    targetFile.absolutePath,
    targetFile.content,
    ts.ScriptTarget.Latest,
    true,
    toScriptKind(ts, targetFile.absolutePath),
  )
  // 落点若是 import/export 中转绑定（specifier/clause/namespace），说明 alias 链断在中途：
  // 沿该语句的模块源追到真实声明；追不到即明确失败，不能把中转行当定义返回
  let importSpecifier: string | null = null
  let importedName = ''
  let importedKind: ImportBinding['kind'] = 'named'
  let cursor = findNodeAtPosition(ts, sourceFile, targetStart)
  while (cursor) {
    if (ts.isImportSpecifier(cursor) || ts.isExportSpecifier(cursor)) {
      importedName = cursor.propertyName?.text || cursor.name.text
      importedKind = 'named'
    } else if (ts.isNamespaceImport(cursor)) {
      importedName = '*'
      importedKind = 'namespace'
    } else if (ts.isImportClause(cursor) && !importedName) {
      importedName = 'default'
      importedKind = 'default'
    } else if (ts.isImportDeclaration(cursor) || ts.isExportDeclaration(cursor)) {
      importSpecifier =
        cursor.moduleSpecifier && ts.isStringLiteralLike(cursor.moduleSpecifier) ? cursor.moduleSpecifier.text : null
      break
    }
    cursor = cursor.parent
  }
  if (importSpecifier && importedName) {
    const moduleFile = await resolveModuleSpecifier(context, targetFile.absolutePath, importSpecifier)
    const hit = moduleFile
      ? await resolveExportedSymbol(
          ts,
          context,
          moduleFile,
          importedName,
          importedName === 'default' ? 'default' : importedKind,
          new Set(),
          signal,
        )
      : null
    if (!hit) return { status: 'not-found' }
    targetFile = hit.file
    sourceFile = hit.sourceFile
    targetStart = hit.node.getStart(hit.sourceFile, false)
  }
  const location = ts.getLineAndCharacterOfPosition(sourceFile, targetStart)
  const relativePath = toRelativePath(context.rootPath, targetFile.absolutePath) || targetFile.path
  return {
    status: 'success',
    target: {
      id: targetFile.id,
      hostId: targetFile.hostId,
      rootId: targetFile.rootId,
      rootLabel: targetFile.rootLabel,
      rootPath: targetFile.rootPath,
      path: relativePath,
      name: targetFile.name,
      absolutePath: targetFile.absolutePath,
      type: 'file',
      line: location.line + 1,
      column: location.character + 1,
    },
  }
}
