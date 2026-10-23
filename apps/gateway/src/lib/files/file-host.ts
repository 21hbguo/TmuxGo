import { getTemporaryUploadTarget, runRemoteFileJson } from './file-roots.js'
import {
  createDirectory,
  createFile,
  listDirectory,
  listTrashEntries,
  readContent,
  readPreview,
  removeEntry,
  renameEntry,
  restoreTrashEntry,
  saveContent,
  transferEntry,
  trashEntry,
} from './file-ops.js'
import { discoverGitRepositories, searchContent, searchName } from './file-search.js'
import { resolveDefaultUploadTarget } from './file-transfer.js'
import type { GitRepositoryInfo, TrashEntry } from './file-types.js'
export async function listDirectoryForHost(hostId: string, rootId: string, relativePath: string, limit?: number) {
  if (hostId === 'local') return listDirectory(rootId, relativePath, limit)
  return runRemoteFileJson(hostId, { op: 'list', root: rootId, path: relativePath, limit })
}
export async function readPreviewForHost(hostId: string, rootId: string, relativePath: string, line = 1) {
  if (hostId === 'local') return readPreview(rootId, relativePath, line)
  return runRemoteFileJson(hostId, { op: 'preview', root: rootId, path: relativePath, line })
}
export async function readContentForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') return readContent(rootId, relativePath)
  return runRemoteFileJson(hostId, { op: 'content', root: rootId, path: relativePath })
}
export async function saveContentForHost(
  hostId: string,
  rootId: string,
  relativePath: string,
  content: string,
  modifiedAt?: string,
) {
  if (hostId === 'local') return saveContent(rootId, relativePath, content, modifiedAt)
  try {
    return await runRemoteFileJson(hostId, { op: 'save', root: rootId, path: relativePath, content, modifiedAt })
  } catch (error) {
    throw normalizeFileModifiedError(error)
  }
}
const FILE_MODIFIED_MARKER = 'FILE_MODIFIED:'
// 远端脚本 raise Exception('FILE_MODIFIED:...')，ssh 传回来的 stderr 是整段 traceback，
// 标记在末行而不是开头（老代码用 startsWith 判定，于是 code 恒为空、冲突只能落 500）。
// 这里按标记位置切出同一行的剩余文案，标记之外的 traceback 不外泄给前端。
function normalizeFileModifiedError(error: unknown) {
  const err = error as Error & { code?: string }
  const raw = typeof err?.message === 'string' ? err.message : ''
  const index = raw.lastIndexOf(FILE_MODIFIED_MARKER)
  if (index >= 0) {
    const tail = raw.slice(index + FILE_MODIFIED_MARKER.length)
    const lineEnd = tail.indexOf('\n')
    err.message = (lineEnd < 0 ? tail : tail.slice(0, lineEnd)).trim() || 'File changed on disk'
    err.code = 'FILE_MODIFIED'
  }
  return err
}
export async function createFileForHost(hostId: string, rootId: string, directoryPath: string, name: string) {
  if (hostId === 'local') return createFile(rootId, directoryPath, name)
  return runRemoteFileJson(hostId, { op: 'create-file', root: rootId, path: directoryPath, name })
}
export async function createDirectoryForHost(hostId: string, rootId: string, directoryPath: string, name: string) {
  if (hostId === 'local') return createDirectory(rootId, directoryPath, name)
  return runRemoteFileJson(hostId, { op: 'create-directory', root: rootId, path: directoryPath, name })
}
export async function renameEntryForHost(hostId: string, rootId: string, relativePath: string, name: string) {
  if (hostId === 'local') return renameEntry(rootId, relativePath, name)
  return runRemoteFileJson(hostId, { op: 'rename', root: rootId, path: relativePath, name })
}
export async function transferEntryForHost(
  hostId: string,
  rootId: string,
  relativePath: string,
  targetRootId: string,
  targetDirectoryPath: string,
  move: boolean,
) {
  if (hostId === 'local') return transferEntry(rootId, relativePath, targetRootId, targetDirectoryPath, move)
  return runRemoteFileJson(hostId, {
    op: move ? 'move' : 'copy',
    root: rootId,
    path: relativePath,
    targetRoot: targetRootId,
    targetPath: targetDirectoryPath,
  })
}
export async function trashEntryForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') return trashEntry(rootId, relativePath)
  return runRemoteFileJson<{ ok: true; entry: TrashEntry }>(hostId, { op: 'trash', root: rootId, path: relativePath })
}
export async function listTrashEntriesForHost(hostId: string) {
  if (hostId === 'local') return listTrashEntries()
  return runRemoteFileJson<TrashEntry[]>(hostId, { op: 'trash-list' })
}
export async function restoreTrashEntryForHost(hostId: string, trashId: string) {
  if (hostId === 'local') return restoreTrashEntry(trashId)
  return runRemoteFileJson(hostId, { op: 'trash-restore', trashId })
}
export async function removeEntryForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') return removeEntry(rootId, relativePath)
  return runRemoteFileJson(hostId, { op: 'remove', root: rootId, path: relativePath })
}
export async function searchNameForHost(
  hostId: string,
  rootId: string,
  query: string,
  basePath = '',
  includeDotFiles = true,
) {
  if (hostId === 'local') return searchName(rootId, query, basePath, includeDotFiles)
  return runRemoteFileJson(hostId, { op: 'search-name', root: rootId, path: basePath, query, includeDotFiles })
}
export async function searchContentForHost(
  hostId: string,
  rootId: string,
  query: string,
  basePath = '',
  includeDotFiles = true,
  ext?: string,
) {
  if (hostId === 'local') return searchContent(rootId, query, basePath, includeDotFiles, ext)
  // ext 仅作 payload 附带字段：对端旧版脚本会忽略未知 key，天然向后兼容
  return runRemoteFileJson(hostId, { op: 'search-content', root: rootId, path: basePath, query, includeDotFiles, ext })
}
export async function resolveDefaultUploadTargetForHost(hostId: string, paneId?: string) {
  if (hostId === 'local') return resolveDefaultUploadTarget(paneId)
  return runRemoteFileJson(hostId, { op: 'default-upload-target' })
}
export async function discoverGitRepositoriesForHost(hostId: string) {
  if (hostId === 'local') return discoverGitRepositories()
  return runRemoteFileJson<GitRepositoryInfo[]>(hostId, { op: 'git-repositories' })
}
export async function resolveTemporaryUploadTargetForHost(hostId: string) {
  if (hostId !== 'local') {
    const target = (await resolveDefaultUploadTargetForHost(hostId)) as {
      rootId: string
      rootLabel: string
      rootPath: string
      path: string
      absolutePath: string
      source: string
    }
    return { ...target, source: 'temporary' as const }
  }
  return getTemporaryUploadTarget()
}
