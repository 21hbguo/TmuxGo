import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { opendir, readFile, stat } from 'fs/promises'
import { isDotPath, isLikelyBinary } from '../file-path.js'
import { getRoots, resolveInside, toFileItem, toRelative } from './file-roots.js'
import { walk } from './file-ops.js'
import {
  FILE_SEARCH_SKIP_DIRS,
  GIT_REPOSITORY_MAX_DEPTH,
  GIT_REPOSITORY_MAX_DIRS,
  GIT_REPOSITORY_MAX_RESULTS,
  GIT_REPOSITORY_SKIP_DIRS,
  LARGE_FILE_LIMIT,
  MAX_RESULTS,
  RG_MAX_BUFFER,
  SEARCH_MATCH_LIMIT,
  type ContentSearchResult,
  type FileItem,
  type GitRepositoryInfo,
  type SearchMatchLine,
} from './file-types.js'
const execFileAsync = promisify(execFile)
function parseSearchQuery(query: string) {
  return query
    .split('|')
    .map((part) => {
      const tokens = Array.from(part.matchAll(/"([^"]+)"|(\S+)/g))
        .map((match) => (match[1] || match[2] || '').trim().toLowerCase())
        .filter(Boolean)
      return [...new Set(tokens)]
    })
    .filter((tokens) => tokens.length > 0)
}
function matchesSearchQuery(value: string, clauses: string[][]) {
  const target = value.toLowerCase()
  return clauses.some((terms) => terms.every((term) => target.includes(term)))
}
function matchesAnySearchTerm(value: string, clauses: string[][]) {
  const target = value.toLowerCase()
  return clauses.some((terms) => terms.some((term) => target.includes(term)))
}
let fdBinary: string | null | undefined
async function resolveFdBinary() {
  if (fdBinary !== undefined) return fdBinary
  for (const name of ['fd', 'fdfind']) {
    try {
      const { stdout } = await execFileAsync(name, ['--version'], { timeout: 2000 })
      if (stdout.toLowerCase().includes('fd')) {
        fdBinary = name
        return fdBinary
      }
    } catch {}
  }
  fdBinary = null
  return fdBinary
}
function escapeGlob(value: string) {
  return value.replace(/[*?[\]{}()!+@\\]/g, '\\$&')
}
async function searchNameWithFd(rootPath: string, absolutePath: string, clauses: string[][], includeDotFiles: boolean) {
  const fd = await resolveFdBinary()
  if (!fd) return null
  const results: FileItem[] = []
  const seen = new Set<string>()
  for (const terms of clauses) {
    const args = ['--hidden', '--no-ignore', '-i', '-t', 'f', '-t', 'd', '--max-results', '1000', '--print0']
    for (const name of FILE_SEARCH_SKIP_DIRS) args.push('-E', name)
    args.push('-g', `*${escapeGlob(terms[0])}*`, absolutePath)
    let stdout: string
    try {
      ;({ stdout } = await execFileAsync(fd, args, { maxBuffer: RG_MAX_BUFFER, timeout: 30000 }))
    } catch (error) {
      const err = error as Error & { code?: number }
      if (err.code === 1 || err.code === 2) continue
      throw error
    }
    for (const raw of stdout.split('\0')) {
      if (!raw) continue
      const relativePath = toRelative(rootPath, raw)
      if (!includeDotFiles && isDotPath(relativePath)) continue
      if (!matchesSearchQuery(path.basename(relativePath), clauses)) continue
      if (seen.has(relativePath)) continue
      seen.add(relativePath)
      try {
        results.push(await toFileItem(rootPath, raw, path.basename(raw)))
      } catch {}
      if (results.length >= MAX_RESULTS) return results
    }
  }
  return results
}
export async function searchName(rootId: string, query: string, basePath = '', includeDotFiles = true) {
  const clauses = parseSearchQuery(query)
  if (!clauses.length) return []
  const pathSearch = path.isAbsolute(query.trim())
  const { root, absolutePath } = await resolveInside(rootId, basePath)
  if (!pathSearch) {
    try {
      const fdResults = await searchNameWithFd(root.path, absolutePath, clauses, includeDotFiles)
      if (fdResults) return fdResults
    } catch {}
  }
  const results: FileItem[] = []
  await walk(root.path, absolutePath, async (current, relativePath, entryType) => {
    if (!includeDotFiles && isDotPath(relativePath)) return entryType === 'directory' ? 'skip' : undefined
    if (
      !matchesSearchQuery(path.basename(relativePath), clauses) &&
      !(pathSearch && matchesSearchQuery(current, clauses))
    )
      return
    try {
      results.push(await toFileItem(root.path, current, path.basename(current)))
    } catch {}
    return results.length < MAX_RESULTS
  })
  return results
}
export async function discoverGitRepositories() {
  const roots = await getRoots()
  const found = new Map<string, GitRepositoryInfo>()
  let directories = 0
  for (const root of roots) {
    const queue = [{ path: root.path, depth: 0 }]
    while (queue.length && directories < GIT_REPOSITORY_MAX_DIRS && found.size < GIT_REPOSITORY_MAX_RESULTS) {
      const current = queue.shift()!
      directories++
      let directory
      try {
        directory = await opendir(current.path)
      } catch {
        continue
      }
      const entries = []
      for await (const entry of directory) entries.push(entry)
      if (entries.some((entry) => entry.name === '.git'))
        found.set(current.path, { path: current.path, label: path.basename(current.path) || current.path })
      if (current.depth >= GIT_REPOSITORY_MAX_DEPTH) continue
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.name === '.git' ||
          entry.name.startsWith('.') ||
          GIT_REPOSITORY_SKIP_DIRS.has(entry.name)
        )
          continue
        queue.push({ path: path.join(current.path, entry.name), depth: current.depth + 1 })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path))
}
async function searchContentWithRg(
  rootPath: string,
  absolutePath: string,
  clauses: string[][],
  includeDotFiles = true,
) {
  const results = new Map<string, ContentSearchResult>()
  for (const terms of clauses) {
    const args = ['--json', '-n', '-i', '--fixed-strings', '--hidden', '-uu', '--max-filesize', '5M', '-m', '5']
    for (const name of FILE_SEARCH_SKIP_DIRS) args.push('-g', `!${name}/**`)
    for (const term of terms) args.push('-e', term)
    args.push('.')
    try {
      const { stdout } = await execFileAsync('rg', args, { cwd: absolutePath, maxBuffer: RG_MAX_BUFFER })
      const matchesByPath = new Map<
        string,
        { path: string; name: string; termHits: Set<string>; matches: SearchMatchLine[] }
      >()
      for (const line of stdout.split('\n')) {
        if (!line) continue
        let payload: any
        try {
          payload = JSON.parse(line)
        } catch {
          continue
        }
        if (payload.type !== 'match') continue
        const rawPath = typeof payload.data?.path?.text === 'string' ? payload.data.path.text : ''
        if (!rawPath) continue
        const resolvedPath = path.resolve(absolutePath, rawPath)
        const relativePath = toRelative(rootPath, resolvedPath)
        if (!includeDotFiles && isDotPath(relativePath)) continue
        const lineNumber = Number(payload.data?.line_number || 0)
        const content =
          typeof payload.data?.lines?.text === 'string'
            ? payload.data.lines.text.replace(/\r?\n$/, '').slice(0, 240)
            : ''
        const item = matchesByPath.get(relativePath) || {
          path: relativePath,
          name: path.basename(relativePath),
          termHits: new Set<string>(),
          matches: [],
        }
        const lowerContent = content.toLowerCase()
        for (const term of terms) {
          if (lowerContent.includes(term)) item.termHits.add(term)
        }
        if (
          lineNumber > 0 &&
          content &&
          item.matches.length < SEARCH_MATCH_LIMIT &&
          !item.matches.some((entry) => entry.number === lineNumber)
        ) {
          item.matches.push({ number: lineNumber, content })
        }
        matchesByPath.set(relativePath, item)
      }
      for (const item of matchesByPath.values()) {
        if (item.termHits.size !== terms.length) continue
        if (results.has(item.path)) {
          const current = results.get(item.path)!
          for (const match of item.matches) {
            if (current.matches.length >= SEARCH_MATCH_LIMIT) break
            if (!current.matches.some((entry) => entry.number === match.number)) current.matches.push(match)
          }
          continue
        }
        try {
          const info = await stat(path.join(rootPath, item.path))
          results.set(item.path, {
            name: item.name,
            path: item.path,
            type: 'file',
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            mode: info.mode & 0o7777,
            matches: item.matches,
          })
        } catch {}
        if (results.size >= MAX_RESULTS) return [...results.values()]
      }
    } catch (error) {
      const err = error as Error & { code?: number }
      if (err.code === 1) continue
      throw error
    }
  }
  return [...results.values()]
}
async function searchContentFallback(rootId: string, clauses: string[][], basePath = '', includeDotFiles = true) {
  const { root, absolutePath } = await resolveInside(rootId, basePath)
  const results: ContentSearchResult[] = []
  await walk(root.path, absolutePath, async (current, relativePath, entryType) => {
    if (!includeDotFiles && isDotPath(relativePath)) return entryType === 'directory' ? 'skip' : undefined
    if (entryType !== 'file') return
    try {
      const info = await stat(current)
      if (info.size > LARGE_FILE_LIMIT) return
      const buffer = await readFile(current)
      if (isLikelyBinary(buffer)) return
      const text = buffer.toString('utf8')
      if (!matchesSearchQuery(text, clauses)) return
      const lines = text.split(/\r?\n/)
      const matches: SearchMatchLine[] = []
      for (let i = 0; i < lines.length && matches.length < SEARCH_MATCH_LIMIT; i++) {
        if (matchesAnySearchTerm(lines[i], clauses)) matches.push({ number: i + 1, content: lines[i].slice(0, 240) })
      }
      if (matches.length)
        results.push({
          path: relativePath,
          name: path.basename(current),
          type: 'file',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          mode: info.mode & 0o7777,
          matches,
        })
    } catch {}
    return results.length < MAX_RESULTS
  })
  return results
}
export async function searchContent(rootId: string, query: string, basePath = '', includeDotFiles = true) {
  const clauses = parseSearchQuery(query)
  if (!clauses.length) return []
  const { root, absolutePath } = await resolveInside(rootId, basePath)
  try {
    return await searchContentWithRg(root.path, absolutePath, clauses, includeDotFiles)
  } catch {
    return searchContentFallback(rootId, clauses, basePath, includeDotFiles)
  }
}
