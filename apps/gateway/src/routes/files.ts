import type { FastifyInstance } from 'fastify'
import { createWriteStream } from 'fs'
import { mkdir, opendir, readFile, realpath, stat } from 'fs/promises'
import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { readFile as readPreferencesFile } from 'fs/promises'

const execFileAsync = promisify(execFile)
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PREVIEW_LIMIT = 200 * 1024
const LARGE_FILE_LIMIT = 512 * 1024
const MAX_DIRS = 8000
const MAX_FILES = 4000
const MAX_RESULTS = 200
const MAX_READ_LINES = 1200
const DEFAULT_UPLOAD_DIR = 'uploads'
const DEFAULT_UPLOAD_RATE_LIMIT_KBPS = 200
const MAX_UPLOAD_RATE_LIMIT_KBPS = 10 * 1024
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
function normalizeRelativePath(relativePath = '') {
  return relativePath.split(/[\\/]+/).filter(Boolean).join('/')
}
function getRootPrefix(rootPath: string) {
  return rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`
}
async function resolveInside(rootId: string, relativePath = '') {
  const roots = await getRoots()
  const root = roots.find((item) => item.id === rootId)
  if (!root) throw new Error('Invalid root')
  const normalizedPath = normalizeRelativePath(relativePath)
  const requested = path.resolve(root.path, normalizedPath || '.')
  const normalizedRoot = getRootPrefix(root.path)
  if (requested !== root.path && !requested.startsWith(normalizedRoot)) throw new Error('Path escapes root')
  let actual = requested
  try {
    actual = await realpath(requested)
  } catch {
    actual = requested
  }
  if (actual !== root.path && !actual.startsWith(normalizedRoot)) throw new Error('Path escapes root')
  return { root, absolutePath: actual, relativePath: normalizeRelativePath(path.relative(root.path, actual)) }
}
function toRelative(rootPath: string, absolutePath: string) {
  return normalizeRelativePath(path.relative(rootPath, absolutePath))
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
async function searchName(rootId: string, query: string, basePath = '') {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const { root, absolutePath } = await resolveInside(rootId, basePath)
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
async function searchContent(rootId: string, query: string, basePath = '') {
  const q = query.trim()
  if (!q) return []
  const qLower = q.toLowerCase()
  const { root, absolutePath } = await resolveInside(rootId, basePath)
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
function getFallbackRoot(roots: FileRoot[]) {
  return roots.find((item) => item.label.toLowerCase() === 'workspace') || roots[0]
}
function mapAbsolutePathToRoot(roots: FileRoot[], absolutePath: string) {
  const sortedRoots = [...roots].sort((a, b) => b.path.length - a.path.length)
  return sortedRoots.find((root) => absolutePath === root.path || absolutePath.startsWith(getRootPrefix(root.path))) || null
}
async function getPaneCurrentPath(paneId: string) {
  await assertTargetAllowed(paneId)
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}'])
  return stdout.trim()
}
async function resolveDefaultUploadTarget(paneId?: string) {
  const roots = await getRoots()
  const fallbackRoot = getFallbackRoot(roots)
  if (paneId) {
    try {
      const cwd = await getPaneCurrentPath(paneId)
      const matchedRoot = mapAbsolutePathToRoot(roots, cwd)
      if (matchedRoot) {
        const relativePath = toRelative(matchedRoot.path, cwd)
        return { rootId: matchedRoot.id, rootLabel: matchedRoot.label, rootPath: matchedRoot.path, path: relativePath, absolutePath: cwd, source: 'pane' as const }
      }
    } catch {}
  }
  const absolutePath = path.join(fallbackRoot.path, DEFAULT_UPLOAD_DIR)
  return { rootId: fallbackRoot.id, rootLabel: fallbackRoot.label, rootPath: fallbackRoot.path, path: DEFAULT_UPLOAD_DIR, absolutePath, source: 'fallback' as const }
}
function sanitizeUploadFileName(filename: string) {
  const normalized = path.basename(filename || '').replace(/\0/g, '').trim()
  if (!normalized || normalized === '.' || normalized === '..') throw new Error('Invalid file name')
  return normalized
}
async function fileExists(absolutePath: string) {
  try {
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}
async function resolveUploadDestination(directoryPath: string, fileName: string) {
  const parsed = path.parse(fileName)
  let attempt = 0
  while (attempt < 1000) {
    const candidateName = attempt === 0 ? fileName : `${parsed.name} (${attempt})${parsed.ext}`
    const candidatePath = path.join(directoryPath, candidateName)
    if (!(await fileExists(candidatePath))) return { candidateName, candidatePath }
    attempt += 1
  }
  throw new Error('Too many conflicting files')
}
function normalizeUploadRateLimitKBps(input: unknown) {
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : NaN
  if (!Number.isFinite(value)) return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  return Math.max(1, Math.min(MAX_UPLOAD_RATE_LIMIT_KBPS, Math.round(value)))
}
async function readStoredUploadRateLimitKBps(profile = 'default') {
  const preferencesDir = process.env.TMUXGO_PREFERENCES_DIR || path.join(os.homedir(), '.tmuxgo', 'preferences')
  const file = path.join(preferencesDir, `${profile}.json`)
  try {
    const content = await readPreferencesFile(file, 'utf8')
    const parsed = JSON.parse(content)
    return normalizeUploadRateLimitKBps(parsed?.uploadRateLimitKBps)
  } catch {
    return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  }
}
function createRateLimitStream(rateLimitKBps: number) {
  const bytesPerSecond = Math.max(1, rateLimitKBps) * 1024
  let budget = bytesPerSecond
  let lastRefill = Date.now()
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  return new Transform({
    async transform(chunk, _encoding, callback) {
      let offset = 0
      try {
        while (offset < chunk.length) {
          const now = Date.now()
          const elapsed = now - lastRefill
          if (elapsed > 0) {
            budget = Math.min(bytesPerSecond, budget + (bytesPerSecond * elapsed) / 1000)
            lastRefill = now
          }
          if (budget < 1) {
            const waitMs = Math.max(1, Math.ceil(((1 - budget) / bytesPerSecond) * 1000))
            await wait(waitMs)
            continue
          }
          const size = Math.min(chunk.length - offset, Math.max(1, Math.floor(budget)))
          this.push(chunk.subarray(offset, offset + size))
          offset += size
          budget -= size
        }
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
  })
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
    const query = request.query as { root?: string; q?: string; basePath?: string }
    return searchName(query.root || '', query.q || '', query.basePath || '')
  })
  fastify.get('/files/search-content', async (request) => {
    const query = request.query as { root?: string; q?: string; basePath?: string }
    return searchContent(query.root || '', query.q || '', query.basePath || '')
  })
  fastify.get('/files/default-upload-target', async (request) => {
    const query = request.query as { paneId?: string }
    return resolveDefaultUploadTarget(query.paneId)
  })
  fastify.post('/files/upload', async (request) => {
    const parts = request.parts()
    let targetRootId = ''
    let targetPath = ''
    let conflictPolicy = 'rename'
    let rateLimitKBps = await readStoredUploadRateLimitKBps()
    let resolvedTarget: Awaited<ReturnType<typeof resolveInside>> | null = null
    const uploadedFiles = []
    for await (const part of parts) {
      if (part.type === 'file') {
        if (!targetRootId) throw new Error('Missing target root')
        if (conflictPolicy !== 'rename') throw new Error('Unsupported conflict policy')
        if (!resolvedTarget) {
          resolvedTarget = await resolveInside(targetRootId, targetPath)
          await mkdir(resolvedTarget.absolutePath, { recursive: true })
        }
        const safeName = sanitizeUploadFileName(part.filename)
        const { candidateName, candidatePath } = await resolveUploadDestination(resolvedTarget.absolutePath, safeName)
        await pipeline(part.file, createRateLimitStream(rateLimitKBps), createWriteStream(candidatePath))
        const info = await stat(candidatePath)
        uploadedFiles.push({
          name: candidateName,
          path: toRelative(resolvedTarget.root.path, candidatePath),
          absolutePath: candidatePath,
          size: info.size,
        })
        continue
      }
      const value = typeof part.value === 'string' ? part.value : ''
      if (part.fieldname === 'targetRootId') targetRootId = value
      else if (part.fieldname === 'targetPath') targetPath = value
      else if (part.fieldname === 'conflictPolicy') conflictPolicy = value || 'rename'
      else if (part.fieldname === 'rateLimitKBps') rateLimitKBps = normalizeUploadRateLimitKBps(value)
    }
    if (!resolvedTarget) throw new Error('No files uploaded')
    return {
      ok: true,
      target: {
        rootId: resolvedTarget.root.id,
        rootLabel: resolvedTarget.root.label,
        rootPath: resolvedTarget.root.path,
        path: resolvedTarget.relativePath,
        absolutePath: resolvedTarget.absolutePath,
        source: 'preferred' as const,
      },
      files: uploadedFiles,
    }
  })
}
