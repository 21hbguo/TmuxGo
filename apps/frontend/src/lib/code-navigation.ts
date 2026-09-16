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
function findNodeAtPosition(ts: TsModule, sourceFile: import('typescript').SourceFile, position: number) {
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
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isImportClause(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
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
function findExportedNode(
  ts: TsModule,
  sourceFile: import('typescript').SourceFile,
  importedName: string,
  kind: ImportBinding['kind'],
) {
  if (kind === 'namespace') return sourceFile
  if (kind === 'default') {
    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword) &&
        hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)
      )
        return statement.name || statement
    }
  }
  for (const statement of sourceFile.statements) {
    if (!hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) continue
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === importedName
    )
      return statement.name
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === importedName) return declaration.name
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      statement.moduleSpecifier
    )
      continue
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== importedName) continue
      return findLocalDeclarationByName(ts, sourceFile, element.propertyName?.text || element.name.text)
    }
  }
  return findLocalDeclarationByName(ts, sourceFile, importedName)
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
export async function resolveEditorDefinition(
  editor: FileEditorDocument,
  position: { line: number; column: number },
  openEditors: FileEditorDocument[],
): Promise<CodeNavigationResult> {
  if (
    !SUPPORTED_LANGUAGES.has(editor.language) &&
    !isNavigableFileName(editor.name || editor.path || editor.absolutePath)
  )
    return { status: 'unsupported' }
  const ts = await loadTypeScript()
  const openEditorMap = new Map(openEditors.map((item) => [normalizePath(item.absolutePath), item] as const))
  openEditorMap.set(normalizePath(editor.absolutePath), editor)
  const context: ResolverContext = {
    hostId: editor.hostId,
    rootId: editor.rootId,
    rootLabel: editor.rootLabel,
    rootPath: normalizePath(editor.rootPath),
    sourceRootPath: joinPath(editor.rootPath, 'src'),
    openEditors: openEditorMap,
    statCache: new Map(),
    fileCache: new Map(),
    moduleCache: new Map(),
  }
  const entryFile = await readResolverFile(context, editor.absolutePath)
  if (!entryFile) return { status: 'not-found' }
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
        if (resolvedFile) {
          const targetSource = ts.createSourceFile(
            resolvedFile.absolutePath,
            resolvedFile.content,
            ts.ScriptTarget.Latest,
            true,
            toScriptKind(ts, resolvedFile.absolutePath),
          )
          const targetNode = findExportedNode(ts, targetSource, binding.importedName, binding.kind)
          const location = ts.getLineAndCharacterOfPosition(
            targetSource,
            targetNode?.getStart(targetSource, false) || 0,
          )
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
  const sourceFile = ts.createSourceFile(
    targetFile.absolutePath,
    targetFile.content,
    ts.ScriptTarget.Latest,
    true,
    toScriptKind(ts, targetFile.absolutePath),
  )
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
