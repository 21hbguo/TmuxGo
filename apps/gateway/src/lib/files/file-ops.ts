import path from 'path'
import { cp, mkdir, opendir, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { getBreadcrumbs, isLikelyBinary, sanitizePathSegment } from '../file-path.js'
import { fileExists, getTrashDir, movePath, resolveInside, toFileItem, toRelative } from './file-roots.js'
import {
  FILE_SEARCH_SKIP_DIRS,
  LARGE_FILE_LIMIT,
  MAX_DIRS,
  MAX_FILES,
  MAX_READ_LINES,
  PREVIEW_LIMIT,
  type FileItem,
  type TrashEntry,
} from './file-types.js'
// 目录列表增量缓存：同目录二次打开命中（dir mtime 未变且在 TTL 内）；
// 子节点懒加载由前端 loadDirectoryChildren 负责，不递归全树
const LIST_CACHE_TTL_MS = Math.max(1000, Number(process.env.TMUXGO_FILE_LIST_TTL_MS || 4000) || 4000)
const LIST_CACHE_MAX = 64
const LIST_PAGE_LIMIT = Math.max(50, Number(process.env.TMUXGO_FILE_LIST_LIMIT || 1500) || 1500)
type ListCacheEntry = {
  mtimeMs: number
  etag: string
  at: number
  payload: Awaited<ReturnType<typeof listDirectoryUncached>>
}
const listDirectoryCache = new Map<string, ListCacheEntry>()

export function invalidateListCache(rootId?: string, relativePath?: string) {
  if (!rootId) {
    listDirectoryCache.clear()
    return
  }
  if (relativePath === undefined) {
    for (const key of [...listDirectoryCache.keys()]) {
      if (key.startsWith(`${rootId}\u0000`)) listDirectoryCache.delete(key)
    }
    return
  }
  // key 含 pageLimit 后缀：按 root+path 前缀删除，避免不同 limit 残留
  const prefix = `${rootId}\u0000${relativePath}\u0000`
  for (const key of [...listDirectoryCache.keys()]) {
    if (key.startsWith(prefix)) listDirectoryCache.delete(key)
  }
}

async function listDirectoryUncached(rootId: string, relativePath: string, pageLimit = LIST_PAGE_LIMIT) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const directory = await opendir(absolutePath)
  const names: string[] = []
  for await (const entry of directory) {
    if (entry.name === '.' || entry.name === '..') continue
    names.push(entry.name)
  }
  // 逐项 stat 在大目录下明显拖慢列表，分批并发 stat
  const items: FileItem[] = []
  const statBatchSize = 64
  for (let i = 0; i < names.length; i += statBatchSize) {
    const batch = await Promise.all(
      names
        .slice(i, i + statBatchSize)
        .map((name) => toFileItem(root.path, path.join(absolutePath, name), name).catch(() => null)),
    )
    for (const item of batch) if (item) items.push(item)
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const limit = Math.max(50, pageLimit || LIST_PAGE_LIMIT)
  const itemsPage = items.slice(0, limit)
  return {
    root,
    path: toRelative(root.path, absolutePath),
    breadcrumbs: getBreadcrumbs(toRelative(root.path, absolutePath)),
    items: itemsPage,
    truncated: items.length > itemsPage.length,
    totalCount: items.length,
    etag: '',
    modifiedAt: '',
  }
}

export async function listDirectory(rootId: string, relativePath: string, limit?: number) {
  const { absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  const mtimeMs = Math.floor(info.mtimeMs)
  const pageLimit = limit || LIST_PAGE_LIMIT
  const key = `${rootId}\u0000${relativePath}\u0000${pageLimit}`
  const now = Date.now()
  const hit = listDirectoryCache.get(key)
  if (hit && hit.mtimeMs === mtimeMs && now - hit.at < LIST_CACHE_TTL_MS) {
    hit.at = now
    return {
      ...hit.payload,
      etag: `${mtimeMs}-${hit.payload.totalCount ?? hit.payload.items.length}`,
      modifiedAt: new Date(mtimeMs).toISOString(),
    }
  }
  const payload = await listDirectoryUncached(rootId, relativePath, limit)
  const etag = `${mtimeMs}-${payload.totalCount ?? payload.items.length}`
  const stamped = { ...payload, etag, modifiedAt: new Date(mtimeMs).toISOString() }
  // 逐出最旧
  if (listDirectoryCache.size >= LIST_CACHE_MAX) {
    const oldest = listDirectoryCache.keys().next().value
    if (oldest !== undefined) listDirectoryCache.delete(oldest)
  }
  listDirectoryCache.set(key, { mtimeMs, etag, at: now, payload: stamped })
  return stamped
}

export async function readPreview(rootId: string, relativePath: string, line = 1) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  if (info.isDirectory())
    return {
      path: toRelative(root.path, absolutePath),
      type: 'directory',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      binary: false,
      truncated: false,
      lines: [],
    }
  if (info.size > LARGE_FILE_LIMIT)
    return {
      path: toRelative(root.path, absolutePath),
      type: 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      binary: false,
      truncated: true,
      reason: 'large-file',
      lines: [],
    }
  const chunk = await readFile(absolutePath)
  if (isLikelyBinary(chunk))
    return {
      path: toRelative(root.path, absolutePath),
      type: 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      binary: true,
      truncated: false,
      reason: 'binary-file',
      lines: [],
    }
  const startLine = Math.max(1, Number(line) || 1)
  const text = chunk.subarray(0, PREVIEW_LIMIT).toString('utf8')
  const allLines = text.split(/\r?\n/)
  const lines = allLines
    .slice(startLine - 1, startLine - 1 + MAX_READ_LINES)
    .map((content, index) => ({ number: startLine + index, content }))
  return {
    path: toRelative(root.path, absolutePath),
    type: 'file',
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    binary: false,
    truncated: chunk.length > PREVIEW_LIMIT || allLines.length > lines.length,
    lines,
  }
}
export async function readContent(rootId: string, relativePath: string) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  if (info.isDirectory())
    return {
      path: toRelative(root.path, absolutePath),
      type: 'directory',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      binary: false,
      truncated: false,
      reason: 'directory',
      encoding: 'utf8',
      content: '',
    }
  if (info.size > LARGE_FILE_LIMIT)
    return {
      path: toRelative(root.path, absolutePath),
      type: 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      binary: false,
      truncated: true,
      reason: 'large-file',
      encoding: 'utf8',
      content: '',
    }
  const chunk = await readFile(absolutePath)
  if (isLikelyBinary(chunk))
    return {
      path: toRelative(root.path, absolutePath),
      type: 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      binary: true,
      truncated: false,
      reason: 'binary-file',
      encoding: 'utf8',
      content: '',
    }
  return {
    path: toRelative(root.path, absolutePath),
    type: 'file',
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    binary: false,
    truncated: false,
    encoding: 'utf8',
    content: chunk.toString('utf8'),
  }
}
export async function saveContent(rootId: string, relativePath: string, content: string, modifiedAt?: string) {
  const { absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  if (info.isDirectory()) throw new Error('Directories cannot be saved')
  if (info.size > LARGE_FILE_LIMIT) throw new Error('Large files are read only')
  const existing = await readFile(absolutePath)
  if (isLikelyBinary(existing)) throw new Error('Binary files are read only')
  const currentModifiedAt = info.mtime.toISOString()
  if (modifiedAt && modifiedAt !== currentModifiedAt) {
    const error = new Error('File changed on disk')
    ;(error as Error & { code?: string }).code = 'FILE_MODIFIED'
    throw error
  }
  await writeFile(absolutePath, content, 'utf8')
  const nextInfo = await stat(absolutePath)
  const parentPath = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
  invalidateListCache(rootId, parentPath)
  return { ok: true as const, content, modifiedAt: nextInfo.mtime.toISOString(), size: nextInfo.size }
}
export async function createFile(rootId: string, directoryPath: string, name: string) {
  const safeName = sanitizePathSegment(name)
  const { root, absolutePath, relativePath } = await resolveInside(rootId, directoryPath)
  const info = await stat(absolutePath)
  if (!info.isDirectory()) throw new Error('Target directory not found')
  const targetPath = path.join(absolutePath, safeName)
  if (await fileExists(targetPath)) throw new Error('File already exists')
  await writeFile(targetPath, '', 'utf8')
  invalidateListCache(rootId, directoryPath || relativePath)
  return { ok: true as const, item: await toFileItem(root.path, targetPath, safeName), parentPath: relativePath }
}
export async function createDirectory(rootId: string, directoryPath: string, name: string) {
  const safeName = sanitizePathSegment(name)
  const { root, absolutePath, relativePath } = await resolveInside(rootId, directoryPath)
  const info = await stat(absolutePath)
  if (!info.isDirectory()) throw new Error('Target directory not found')
  const targetPath = path.join(absolutePath, safeName)
  if (await fileExists(targetPath)) throw new Error('Directory already exists')
  await mkdir(targetPath, { recursive: false })
  invalidateListCache(rootId, directoryPath || relativePath)
  return { ok: true as const, item: await toFileItem(root.path, targetPath, safeName), parentPath: relativePath }
}
export async function renameEntry(rootId: string, relativePath: string, name: string) {
  const safeName = sanitizePathSegment(name)
  const { root, absolutePath, relativePath: currentPath } = await resolveInside(rootId, relativePath)
  const targetPath = path.join(path.dirname(absolutePath), safeName)
  if (absolutePath === root.path) throw new Error('Root cannot be renamed')
  if (targetPath === absolutePath)
    return { ok: true as const, item: await toFileItem(root.path, absolutePath, safeName), previousPath: currentPath }
  if (await fileExists(targetPath)) throw new Error('Target already exists')
  await rename(absolutePath, targetPath)
  const parentRel = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : ''
  invalidateListCache(rootId, parentRel)
  return { ok: true as const, item: await toFileItem(root.path, targetPath, safeName), previousPath: currentPath }
}
export async function removeEntry(rootId: string, relativePath: string) {
  const { root, absolutePath, relativePath: currentPath } = await resolveInside(rootId, relativePath)
  if (absolutePath === root.path) throw new Error('Root cannot be removed')
  const info = await stat(absolutePath)
  if (info.isDirectory()) await rm(absolutePath, { recursive: true, force: false })
  else await unlink(absolutePath)
  const parentRel = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : ''
  invalidateListCache(rootId, parentRel)
  return { ok: true as const, path: currentPath, type: info.isDirectory() ? ('directory' as const) : ('file' as const) }
}
export async function transferEntry(
  rootId: string,
  relativePath: string,
  targetRootId: string,
  targetDirectoryPath: string,
  move: boolean,
) {
  const source = await resolveInside(rootId, relativePath)
  const targetDirectory = await resolveInside(targetRootId, targetDirectoryPath)
  const targetDirectoryInfo = await stat(targetDirectory.absolutePath)
  if (!targetDirectoryInfo.isDirectory()) throw new Error('Target directory not found')
  if (source.absolutePath === source.root.path) throw new Error('Root cannot be transferred')
  const targetName = await availableCopyName(targetDirectory.absolutePath, path.basename(source.absolutePath))
  const targetPath = path.join(targetDirectory.absolutePath, targetName)
  if (move) await movePath(source.absolutePath, targetPath)
  else await cp(source.absolutePath, targetPath, { recursive: true, preserveTimestamps: true })
  invalidateListCache(
    rootId,
    source.relativePath.includes('/') ? source.relativePath.slice(0, source.relativePath.lastIndexOf('/')) : '',
  )
  invalidateListCache(targetRootId, targetDirectory.relativePath)
  return {
    ok: true as const,
    item: await toFileItem(targetDirectory.root.path, targetPath, path.basename(targetPath)),
    previousPath: source.relativePath,
  }
}
// 与 VSCode 一致的冲突改名：name.ext → name copy.ext → name copy 2.ext
export async function availableCopyName(directory: string, name: string) {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0
  const stem = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${stem} copy${i === 1 ? '' : ` ${i}`}${ext}`
    if (!(await fileExists(path.join(directory, candidate)))) return candidate
  }
  throw new Error('Too many conflicting files')
}
export async function trashEntry(rootId: string, relativePath: string) {
  const resolved = await resolveInside(rootId, relativePath)
  if (resolved.absolutePath === resolved.root.path) throw new Error('Root cannot be trashed')
  const info = await stat(resolved.absolutePath)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const entryDir = path.join(getTrashDir(), id)
  await mkdir(entryDir, { recursive: true })
  await movePath(resolved.absolutePath, path.join(entryDir, 'data'))
  const trashParent = resolved.relativePath.includes('/')
    ? resolved.relativePath.slice(0, resolved.relativePath.lastIndexOf('/'))
    : ''
  invalidateListCache(rootId, trashParent)
  const entry: TrashEntry = {
    id,
    rootId,
    path: resolved.relativePath,
    name: path.basename(resolved.absolutePath),
    type: info.isDirectory() ? 'directory' : 'file',
    deletedAt: new Date().toISOString(),
  }
  await writeFile(path.join(entryDir, 'meta.json'), JSON.stringify(entry), 'utf8')
  return { ok: true as const, entry }
}
export async function listTrashEntries() {
  const entries: TrashEntry[] = []
  let directory
  try {
    directory = await opendir(getTrashDir())
  } catch {
    return entries
  }
  for await (const item of directory) {
    if (!item.isDirectory()) continue
    try {
      entries.push(JSON.parse(await readFile(path.join(getTrashDir(), item.name, 'meta.json'), 'utf8')) as TrashEntry)
    } catch {}
  }
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}
export async function restoreTrashEntry(trashId: string) {
  const id = sanitizePathSegment(trashId)
  const entryDir = path.join(getTrashDir(), id)
  const entry = JSON.parse(await readFile(path.join(entryDir, 'meta.json'), 'utf8')) as TrashEntry
  const target = await resolveInside(entry.rootId, entry.path)
  if (await fileExists(target.absolutePath)) throw new Error('Restore target already exists')
  await mkdir(path.dirname(target.absolutePath), { recursive: true })
  await movePath(path.join(entryDir, 'data'), target.absolutePath)
  await rm(entryDir, { recursive: true, force: true })
  invalidateListCache(
    entry.rootId,
    target.relativePath.includes('/') ? target.relativePath.slice(0, target.relativePath.lastIndexOf('/')) : '',
  )
  return {
    ok: true as const,
    item: await toFileItem(target.root.path, target.absolutePath, path.basename(target.absolutePath)),
  }
}
export async function walk(
  rootPath: string,
  startPath: string,
  visitor: (
    absolutePath: string,
    relativePath: string,
    entryType: 'file' | 'directory',
  ) => Promise<boolean | 'skip' | void>,
) {
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
        const result = await visitor(absolutePath, relativePath, 'directory')
        if (result === false) return
        if (result === 'skip') continue
        if (FILE_SEARCH_SKIP_DIRS.has(entry.name)) continue
        queue.push(absolutePath)
      } else if (entry.isFile()) {
        files++
        if ((await visitor(absolutePath, relativePath, 'file')) === false) return
      }
      if (dirs >= MAX_DIRS || files >= MAX_FILES) return
    }
  }
}
