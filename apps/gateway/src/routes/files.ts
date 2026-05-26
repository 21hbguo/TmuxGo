import type { FastifyInstance } from 'fastify'
import { opendir, readFile, realpath, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PREVIEW_LIMIT = 200 * 1024
const LARGE_FILE_LIMIT = 512 * 1024
const MAX_DIRS = 8000
const MAX_FILES = 4000
const MAX_RESULTS = 200
const MAX_READ_LINES = 1200
const homeRoot = os.homedir()
const rootSpec = process.env.TMUX_WEB_FILE_ROOTS || `workspace=${defaultRoot}${path.delimiter}home=${homeRoot}`

interface FileRoot {
  id: string
  label: string
  path: string
}
interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
}

let rootsCache: Promise<FileRoot[]> | null = null

async function getRoots() {
  if (!rootsCache) {
    rootsCache = Promise.all(rootSpec.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map(async (entry, index) => {
      const [labelRaw, pathRaw] = entry.includes('=') ? entry.split(/=(.*)/s).filter(Boolean) : ['', entry]
      const resolved = await realpath(path.resolve(pathRaw))
      return { id: `root-${index}`, label: labelRaw || path.basename(resolved) || resolved, path: resolved }
    }))
  }
  return rootsCache
}
async function resolveInside(rootId: string, relativePath = '') {
  const roots = await getRoots()
  const root = roots.find((item) => item.id === rootId)
  if (!root) throw new Error('Invalid root')
  const requested = path.resolve(root.path, relativePath || '.')
  const normalizedRoot = root.path.endsWith(path.sep) ? root.path : `${root.path}${path.sep}`
  if (requested !== root.path && !requested.startsWith(normalizedRoot)) throw new Error('Path escapes root')
  let actual = requested
  try {
    actual = await realpath(requested)
  } catch {
    actual = requested
  }
  if (actual !== root.path && !actual.startsWith(normalizedRoot)) throw new Error('Path escapes root')
  return { root, absolutePath: actual, relativePath: path.relative(root.path, actual) }
}
function toRelative(rootPath: string, absolutePath: string) {
  return path.relative(rootPath, absolutePath).split(path.sep).join('/')
}
function getBreadcrumbs(relativePath: string) {
  const parts = relativePath ? relativePath.split(/[\\/]+/).filter(Boolean) : []
  return [{ name: '/', path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))]
}
function isLikelyBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  return sample.includes(0)
}
async function toFileItem(rootPath: string, absolutePath: string, name: string): Promise<FileItem> {
  const info = await stat(absolutePath)
  return {
    name,
    path: toRelative(rootPath, absolutePath),
    type: info.isDirectory() ? 'directory' : 'file',
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  }
}
async function listDirectory(rootId: string, relativePath: string) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const directory = await opendir(absolutePath)
  const items: FileItem[] = []
  for await (const entry of directory) {
    if (entry.name === '.' || entry.name === '..') continue
    try {
      items.push(await toFileItem(root.path, path.join(absolutePath, entry.name), entry.name))
    } catch {}
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { root, path: toRelative(root.path, absolutePath), breadcrumbs: getBreadcrumbs(toRelative(root.path, absolutePath)), items }
}
async function readPreview(rootId: string, relativePath: string, line = 1) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  if (info.isDirectory()) return { path: toRelative(root.path, absolutePath), type: 'directory', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: false, lines: [] }
  if (info.size > LARGE_FILE_LIMIT) return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: true, reason: 'large-file', lines: [] }
  const chunk = await readFile(absolutePath)
  if (isLikelyBinary(chunk)) return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: true, truncated: false, reason: 'binary-file', lines: [] }
  const startLine = Math.max(1, Number(line) || 1)
  const text = chunk.subarray(0, PREVIEW_LIMIT).toString('utf8')
  const allLines = text.split(/\r?\n/)
  const lines = allLines.slice(startLine - 1, startLine - 1 + MAX_READ_LINES).map((content, index) => ({ number: startLine + index, content }))
  return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: chunk.length > PREVIEW_LIMIT || allLines.length > lines.length, lines }
}
async function walk(rootPath: string, startPath: string, visitor: (absolutePath: string, relativePath: string, entryType: 'file' | 'directory') => Promise<boolean | void>) {
  const queue = [startPath]
  let dirs = 0
  let files = 0
  while (queue.length && dirs < MAX_DIRS && files < MAX_FILES) {
    const current = queue.shift()!
    dirs++
    let directory
    try {
      directory = await opendir(current)
    } catch {
      continue
    }
    for await (const entry of directory) {
      const absolutePath = path.join(current, entry.name)
      const relativePath = toRelative(rootPath, absolutePath)
      if (entry.isDirectory()) {
        if (await visitor(absolutePath, relativePath, 'directory') === false) return
        queue.push(absolutePath)
      } else if (entry.isFile()) {
        files++
        if (await visitor(absolutePath, relativePath, 'file') === false) return
      }
      if (dirs >= MAX_DIRS || files >= MAX_FILES) return
    }
  }
}
async function searchName(rootId: string, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const { root, absolutePath } = await resolveInside(rootId, '')
  const results: FileItem[] = []
  await walk(root.path, absolutePath, async (current, relativePath) => {
    if (!path.basename(relativePath).toLowerCase().includes(q)) return
    try {
      results.push(await toFileItem(root.path, current, path.basename(current)))
    } catch {}
    return results.length < MAX_RESULTS
  })
  return results
}
async function searchContent(rootId: string, query: string) {
  const q = query.trim()
  if (!q) return []
  const qLower = q.toLowerCase()
  const { root, absolutePath } = await resolveInside(rootId, '')
  const results: any[] = []
  await walk(root.path, absolutePath, async (current, relativePath, entryType) => {
    if (entryType !== 'file') return
    let info
    try {
      info = await stat(current)
      if (info.size > LARGE_FILE_LIMIT) return
      const buffer = await readFile(current)
      if (isLikelyBinary(buffer)) return
      const text = buffer.toString('utf8')
      const lines = text.split(/\r?\n/)
      const matches = []
      for (let i = 0; i < lines.length && matches.length < 3; i++) {
        if (lines[i].toLowerCase().includes(qLower)) matches.push({ number: i + 1, content: lines[i].slice(0, 240) })
      }
      if (matches.length) results.push({ path: relativePath, name: path.basename(current), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), matches })
    } catch {}
    return results.length < MAX_RESULTS
  })
  return results
}

export async function fileRoutes(fastify: FastifyInstance) {
  fastify.get('/files/roots', async () => {
    return getRoots()
  })
  fastify.get('/files/list', async (request) => {
    const query = request.query as { root?: string; path?: string }
    return listDirectory(query.root || '', query.path || '')
  })
  fastify.get('/files/preview', async (request) => {
    const query = request.query as { root?: string; path?: string; line?: string }
    return readPreview(query.root || '', query.path || '', parseInt(query.line || '1', 10))
  })
  fastify.get('/files/search-name', async (request) => {
    const query = request.query as { root?: string; q?: string }
    return searchName(query.root || '', query.q || '')
  })
  fastify.get('/files/search-content', async (request) => {
    const query = request.query as { root?: string; q?: string }
    return searchContent(query.root || '', query.q || '')
  })
}
