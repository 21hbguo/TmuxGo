import type { FastifyInstance } from 'fastify'
import type { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, stat } from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { emitPluginEvent } from '../lib/plugin-manager.js'
import {
  fileContentBodySchema,
  fileEntryBodySchema,
  fileRemoveQuerySchema,
  fileRestoreBodySchema,
  fileTransferBodySchema,
  fileTrashBodySchema,
  hostParamsSchema,
} from '../lib/request-validation.js'
import { taskManager, type TaskManager } from '../lib/task-manager.js'
import {
  cleanupExpiredTemporaryUploads,
  getRoots,
  resolveFileForHost,
  resolveInside,
  runRemoteFileJson,
  startTemporaryUploadCleanup,
  toRelative,
} from '../lib/files/file-roots.js'
import {
  createDirectoryForHost,
  createFileForHost,
  discoverGitRepositoriesForHost,
  listDirectoryForHost,
  listTrashEntriesForHost,
  readContentForHost,
  readPreviewForHost,
  removeEntryForHost,
  renameEntryForHost,
  resolveDefaultUploadTargetForHost,
  resolveTemporaryUploadTargetForHost,
  restoreTrashEntryForHost,
  saveContentForHost,
  searchContentForHost,
  searchNameForHost,
  transferEntryForHost,
  trashEntryForHost,
} from '../lib/files/file-host.js'
import {
  cleanupExpiredDownloadArtifacts,
  createRateLimitStream,
  getDownloadArtifactPath,
  getDownloadStream,
  getImageMimeType,
  normalizeUploadRateLimitKBps,
  readStoredUploadRateLimitKBps,
  resolveDownloadRateLimitKBps,
  resolveUploadDestination,
  runBackgroundDownloadTask,
  runBackgroundUploadTask,
  sanitizeUploadFileName,
  stageUploadFile,
  startDownloadArtifactCleanup,
  writeRemoteUpload,
} from '../lib/files/file-transfer.js'
import { TEMP_UPLOAD_ROOT_ID, type FileRoot, type StagedUploadFile } from '../lib/files/file-types.js'
import { isHtmlMime, resolveRawMime } from '../lib/files/raw-mime.js'
import { parseSingleRange } from '../lib/files/raw-range.js'
import { limitBytes } from '../lib/files/raw-stream.js'
export {
  TEMP_UPLOAD_ROOT_ID,
  cleanupExpiredTemporaryUploads,
  cleanupExpiredDownloadArtifacts,
  runBackgroundDownloadTask,
  readContentForHost,
  saveContentForHost,
  discoverGitRepositoriesForHost,
}
export type { GitRepositoryInfo } from '../lib/files/file-types.js'
function stripWeakEtag(value: string) {
  return value.startsWith('W/') ? value.slice(2) : value
}
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true
  const target = stripWeakEtag(etag)
  return header.split(',').some((part) => stripWeakEtag(part.trim()) === target)
}
// If-Range：强校验（不匹配就回落 200 全量），ETag 用弱比较、否则比 Last-Modified
function ifRangeMatches(header: string, etag: string, lastModified: string): boolean {
  const value = header.trim()
  if (value.startsWith('"') || value.startsWith('W/')) return stripWeakEtag(value) === stripWeakEtag(etag)
  return value === lastModified
}
function parseRawRateLimitKBps(value?: string): number {
  if (!value) return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(parsed, 10 * 1024)
}
// 中文文件名必须走 filename*：ASCII 回退只保留安全字符，避免 header 注入
function rawContentDisposition(name: string, download: boolean) {
  const fallback = name.replace(/[^\w.-]/g, '_').slice(0, 120) || 'file'
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).slice(0, 300)}`
}
export async function fileRoutes(fastify: FastifyInstance, options: { taskManager?: TaskManager } = {}) {
  const backgroundTasks = options.taskManager || taskManager
  backgroundTasks.register('file-upload', runBackgroundUploadTask)
  backgroundTasks.register('file-download', runBackgroundDownloadTask)
  startTemporaryUploadCleanup()
  startDownloadArtifactCleanup(backgroundTasks)
  fastify.get('/hosts/:hostId/files/roots', async (request) => {
    const { hostId } = request.params as { hostId: string }
    if (hostId === 'local') return getRoots()
    return runRemoteFileJson<FileRoot[]>(hostId, { op: 'roots' })
  })
  fastify.get('/hosts/:hostId/files/list', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string; limit?: string }
    const limit = query.limit ? Math.max(50, Number(query.limit) || 0) : undefined
    return listDirectoryForHost(hostId, query.root || '', query.path || '', limit)
  })
  fastify.get('/hosts/:hostId/files/preview', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string; line?: string }
    return readPreviewForHost(hostId, query.root || '', query.path || '', parseInt(query.line || '1', 10))
  })
  fastify.get('/hosts/:hostId/files/content', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string }
    return readContentForHost(hostId, query.root || '', query.path || '')
  })
  fastify.put('/hosts/:hostId/files/content', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileContentBodySchema.parse(request.body)
    try {
      const result = await saveContentForHost(hostId, body.root, body.path, body.content, body.modifiedAt)
      emitPluginEvent('file.saved', { hostId, rootId: body.root, filePath: body.path })
      return result
    } catch (error) {
      const err = error as Error & { code?: string }
      if (err.code === 'FILE_MODIFIED') return reply.status(409).send({ message: err.message, code: err.code })
      return reply.status(400).send({ message: err.message || 'Save failed', code: err.code || 'SAVE_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/create-file', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileEntryBodySchema.parse(request.body)
    try {
      return await createFileForHost(hostId, body.root, body.path, body.name)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Create failed', code: 'CREATE_FILE_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/create-directory', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileEntryBodySchema.parse(request.body)
    try {
      return await createDirectoryForHost(hostId, body.root, body.path, body.name)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Create failed', code: 'CREATE_DIRECTORY_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/rename', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileEntryBodySchema.parse(request.body)
    try {
      return await renameEntryForHost(hostId, body.root, body.path, body.name)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Rename failed', code: 'RENAME_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/copy', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileTransferBodySchema.parse(request.body)
    try {
      return await transferEntryForHost(hostId, body.root, body.path, body.targetRoot, body.targetPath, false)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Copy failed', code: 'COPY_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/move', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileTransferBodySchema.parse(request.body)
    try {
      return await transferEntryForHost(hostId, body.root, body.path, body.targetRoot, body.targetPath, true)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Move failed', code: 'MOVE_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/trash', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileTrashBodySchema.parse(request.body)
    try {
      return await trashEntryForHost(hostId, body.root, body.path)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Trash failed', code: 'TRASH_FAILED' })
    }
  })
  fastify.get('/hosts/:hostId/files/trash', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return { entries: await listTrashEntriesForHost(hostId) }
  })
  fastify.post('/hosts/:hostId/files/restore', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = fileRestoreBodySchema.parse(request.body)
    try {
      return await restoreTrashEntryForHost(hostId, body.trashId)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Restore failed', code: 'RESTORE_FAILED' })
    }
  })
  fastify.delete('/hosts/:hostId/files/remove', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const query = fileRemoveQuerySchema.parse(request.query)
    try {
      return await removeEntryForHost(hostId, query.root, query.path)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Remove failed', code: 'REMOVE_FAILED' })
    }
  })
  fastify.get('/hosts/:hostId/files/search-name', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; q?: string; basePath?: string; includeDotFiles?: string }
    return searchNameForHost(
      hostId,
      query.root || '',
      query.q || '',
      query.basePath || '',
      query.includeDotFiles !== 'false',
    )
  })
  fastify.get('/hosts/:hostId/files/search-content', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as {
      root?: string
      q?: string
      basePath?: string
      includeDotFiles?: string
      // 可选扩展名过滤（代码跳转按入口文件类型收窄扫描面）；旧客户端不带此参数
      ext?: string
    }
    return searchContentForHost(
      hostId,
      query.root || '',
      query.q || '',
      query.basePath || '',
      query.includeDotFiles !== 'false',
      query.ext || undefined,
    )
  })
  fastify.get('/hosts/:hostId/files/default-upload-target', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { paneId?: string }
    return resolveDefaultUploadTargetForHost(hostId, query.paneId)
  })
  fastify.get('/hosts/:hostId/files/temporary-upload-target', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    try {
      return await resolveTemporaryUploadTargetForHost(hostId)
    } catch (error) {
      const err = error as Error
      return reply
        .status(400)
        .send({ message: err.message || 'Temporary upload target failed', code: 'TEMP_UPLOAD_TARGET_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/upload', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const parts = request.parts()
    let targetRootId = ''
    let targetPath = ''
    let conflictPolicy = 'rename'
    let background = false
    let rateLimitKBps = await readStoredUploadRateLimitKBps()
    let resolvedTarget: { root: FileRoot; absolutePath: string; relativePath: string } | null = null
    const uploadedFiles: { name: string; path: string; absolutePath: string; size: number }[] = []
    const stagedFiles: StagedUploadFile[] = []
    // 客户端参数缺失按 400 返回——裸 Error 会被默认错误序列化成 500
    const badRequest = (message: string) => {
      const error = new Error(message) as Error & { statusCode: number }
      error.statusCode = 400
      return error
    }
    for await (const part of parts) {
      if (part.type === 'file') {
        if (!targetRootId) throw badRequest('Missing target root')
        if (conflictPolicy !== 'rename') throw badRequest('Unsupported conflict policy')
        let safeName: string
        try {
          safeName = sanitizeUploadFileName(part.filename)
        } catch (error) {
          throw badRequest((error as Error).message)
        }
        if (background) {
          stagedFiles.push(await stageUploadFile(part.file, safeName, rateLimitKBps))
          continue
        }
        if (!resolvedTarget && hostId === 'local') {
          resolvedTarget = await resolveInside(targetRootId, targetPath)
          await mkdir(resolvedTarget.absolutePath, { recursive: true })
        }
        if (hostId === 'local') {
          const { candidateName, candidatePath } = await resolveUploadDestination(
            resolvedTarget!.absolutePath,
            safeName,
          )
          await pipeline(part.file, createRateLimitStream(rateLimitKBps), createWriteStream(candidatePath))
          const info = await stat(candidatePath)
          uploadedFiles.push({
            name: candidateName,
            path: toRelative(resolvedTarget!.root.path, candidatePath),
            absolutePath: candidatePath,
            size: info.size,
          })
        } else {
          const prepared = await runRemoteFileJson<{
            root: FileRoot
            directoryPath: string
            directoryAbsolutePath: string
            name: string
            path: string
            absolutePath: string
          }>(hostId, { op: 'prepare-upload', root: targetRootId, path: targetPath, name: safeName })
          if (!resolvedTarget)
            resolvedTarget = {
              root: prepared.root,
              absolutePath: prepared.directoryAbsolutePath,
              relativePath: prepared.directoryPath,
            }
          await writeRemoteUpload(hostId, prepared.absolutePath, part.file, rateLimitKBps)
          const info = await resolveFileForHost(hostId, prepared.root.id, prepared.path)
          uploadedFiles.push({
            name: prepared.name,
            path: prepared.path,
            absolutePath: prepared.absolutePath,
            size: info.size,
          })
        }
        continue
      }
      const value = typeof part.value === 'string' ? part.value : ''
      if (part.fieldname === 'targetRootId') targetRootId = value
      else if (part.fieldname === 'targetPath') targetPath = value
      else if (part.fieldname === 'conflictPolicy') conflictPolicy = value || 'rename'
      else if (part.fieldname === 'rateLimitKBps') rateLimitKBps = normalizeUploadRateLimitKBps(value)
      else if (part.fieldname === 'background') background = value === 'true'
    }
    if (background) {
      if (!stagedFiles.length) throw badRequest('No files uploaded')
      return reply.status(202).send({
        task: await backgroundTasks.start({
          type: 'file-upload',
          title: `Upload ${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'}`,
          input: { hostId, targetRootId, targetPath, conflictPolicy, rateLimitKBps, files: stagedFiles },
        }),
      })
    }
    if (!resolvedTarget) throw badRequest('No files uploaded')
    const result = {
      ok: true,
      target: {
        rootId: resolvedTarget.root.id,
        rootLabel: resolvedTarget.root.label,
        rootPath: resolvedTarget.root.path,
        path: resolvedTarget.relativePath,
        absolutePath: resolvedTarget.absolutePath,
        source: resolvedTarget.root.id === TEMP_UPLOAD_ROOT_ID ? ('temporary' as const) : ('preferred' as const),
      },
      files: uploadedFiles,
    }
    emitPluginEvent('file.uploaded', {
      hostId,
      rootId: resolvedTarget.root.id,
      filePath: resolvedTarget.relativePath,
      files: uploadedFiles.map((file) => ({ name: file.name, path: file.path, size: file.size })),
    })
    return result
  })
  fastify.get('/hosts/:hostId/files/download', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string; profile?: string; rateLimitKBps?: string }
    try {
      const fileInfo = await resolveFileForHost(hostId, query.root || '', query.path || '')
      const rateLimitKBps = await resolveDownloadRateLimitKBps(query.rateLimitKBps, query.profile || 'default')
      const directory = !fileInfo.isFile
      const fileName = directory ? `${path.basename(fileInfo.absolutePath)}.zip` : path.basename(fileInfo.absolutePath)
      reply.header('Content-Type', directory ? 'application/zip' : 'application/octet-stream')
      if (!directory) reply.header('Content-Length', String(fileInfo.size))
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName).replace(/%20/g, ' ')}"`)
      const stream =
        hostId === 'local' && !directory
          ? createReadStream(fileInfo.absolutePath)
          : await getDownloadStream(hostId, fileInfo.absolutePath, directory)
      return reply.send(stream.pipe(createRateLimitStream(rateLimitKBps)))
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Download failed', code: 'DOWNLOAD_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/download-tasks', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = request.body as { root?: unknown; path?: unknown; rateLimitKBps?: unknown }
    const rootId = typeof body?.root === 'string' ? body.root : ''
    const relativePath = typeof body?.path === 'string' ? body.path : ''
    try {
      const fileInfo = await resolveFileForHost(hostId, rootId, relativePath)
      const rateLimitKBps = await resolveDownloadRateLimitKBps(body?.rateLimitKBps)
      const fileName = fileInfo.isFile
        ? path.basename(fileInfo.absolutePath)
        : `${path.basename(fileInfo.absolutePath)}.zip`
      return reply.status(202).send({
        task: await backgroundTasks.start({
          type: 'file-download',
          title: `Download ${fileName}`,
          input: { hostId, rootId, path: relativePath, rateLimitKBps, artifactId: randomUUID() },
        }),
      })
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Download failed', code: 'DOWNLOAD_FAILED' })
    }
  })
  fastify.get('/hosts/:hostId/files/download-tasks/:artifactId', async (request, reply) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const { artifactId } = request.params as { artifactId: string }
    const task = backgroundTasks
      .list()
      .find(
        (item) =>
          item.type === 'file-download' &&
          item.status === 'success' &&
          typeof item.result === 'object' &&
          item.result !== null &&
          (item.result as { downloadUrl?: unknown }).downloadUrl ===
            `/api/hosts/${encodeURIComponent(hostId)}/files/download-tasks/${artifactId}`,
      )
    const result = task?.result as { fileName?: unknown; size?: unknown } | undefined
    if (!result || typeof result.fileName !== 'string' || typeof result.size !== 'number')
      return reply.status(404).send({ message: 'Download artifact not found', code: 'DOWNLOAD_ARTIFACT_NOT_FOUND' })
    try {
      const artifactPath = getDownloadArtifactPath(artifactId)
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Length', String(result.size))
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(result.fileName).replace(/%20/g, ' ')}"`,
      )
      return reply.send(createReadStream(artifactPath))
    } catch (error) {
      const err = error as Error
      return reply
        .status(404)
        .send({ message: err.message || 'Download artifact not found', code: 'DOWNLOAD_ARTIFACT_NOT_FOUND' })
    }
  })
  fastify.get('/hosts/:hostId/files/image', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string }
    try {
      const fileInfo = await resolveFileForHost(hostId, query.root || '', query.path || '')
      if (!fileInfo.isFile)
        return reply
          .status(400)
          .send({ message: 'Directories are not previewable here', code: 'IMAGE_PREVIEW_UNSUPPORTED' })
      const mimeType = getImageMimeType(fileInfo.absolutePath)
      if (!mimeType)
        return reply
          .status(400)
          .send({ message: 'Image preview unavailable for this file type', code: 'IMAGE_TYPE_UNSUPPORTED' })
      reply.header('Content-Type', mimeType)
      reply.header('Content-Length', String(fileInfo.size))
      reply.header(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(path.basename(fileInfo.absolutePath)).replace(/%20/g, ' ')}"`,
      )
      reply.header('Cache-Control', 'no-store')
      reply.header('X-Content-Type-Options', 'nosniff')
      if (hostId === 'local') return reply.send(createReadStream(fileInfo.absolutePath))
      return reply.send(await getDownloadStream(hostId, fileInfo.absolutePath, false))
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Image preview failed', code: 'IMAGE_PREVIEW_FAILED' })
    }
  })
  fastify.get('/hosts/:hostId/files/raw/:rootId/*', async (request, reply) => {
    const { hostId, rootId } = request.params as { hostId: string; rootId: string }
    // 通配段已由 find-my-way 解码，不能再 decode 一次（文件名里的 % 会被二次解码）
    const relativePath = (request.params as Record<string, string>)['*'] || ''
    const query = request.query as { download?: string; rateLimitKBps?: string }
    if (!relativePath) return reply.status(400).send({ message: 'Missing file path', code: 'RAW_BAD_REQUEST' })
    const download = query.download === '1' || query.download === 'true'
    let info: Awaited<ReturnType<typeof resolveFileForHost>>
    try {
      info = await resolveFileForHost(hostId, rootId, relativePath)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      // 错误消息可能带绝对路径，一律换成固定文案
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR')
        return reply.status(404).send({ message: 'File not found', code: 'RAW_NOT_FOUND' })
      return reply.status(400).send({ message: 'Invalid file path', code: 'RAW_BAD_REQUEST' })
    }
    if (!info.isFile)
      return reply.status(400).send({ message: 'Directories are not streamable here', code: 'RAW_BAD_REQUEST' })
    const mime = resolveRawMime(info.absolutePath, download)
    if (!mime)
      return reply.status(415).send({ message: 'Preview unavailable for this file type', code: 'RAW_TYPE_UNSUPPORTED' })
    const mtimeMs = Date.parse(info.modifiedAt)
    const modifiedAt = Number.isFinite(mtimeMs) ? mtimeMs : 0
    const etag = `W/"${info.size}-${modifiedAt}"`
    const lastModified = new Date(modifiedAt).toUTCString()
    reply.header('Content-Type', mime)
    reply.header('Accept-Ranges', 'bytes')
    reply.header('ETag', etag)
    reply.header('Last-Modified', lastModified)
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    reply.header('Content-Disposition', rawContentDisposition(relativePath.split('/').pop() || 'file', download))
    // HTML 内联直出等于给攻击者的页面一个应用源：sandbox 把它的 origin 变成 opaque
    if (isHtmlMime(mime)) reply.header('Content-Security-Policy', 'sandbox')

    const ifNoneMatch = request.headers['if-none-match']
    if (typeof ifNoneMatch === 'string' && etagMatches(ifNoneMatch, etag)) return reply.status(304).send()

    const ifRange = request.headers['if-range']
    const rangeHeader = request.headers.range
    const rangeAllowed = typeof ifRange !== 'string' || ifRangeMatches(ifRange, etag, lastModified)
    const parsed = rangeAllowed
      ? parseSingleRange(typeof rangeHeader === 'string' ? rangeHeader : undefined, info.size)
      : null
    if (parsed === 'invalid')
      return (
        reply
          .status(416)
          .header('Content-Range', `bytes */${info.size}`)
          // 错误体是 JSON，但前面已按文件类型设过 Content-Type，必须显式改回
          .type('application/json; charset=utf-8')
          .send({ message: 'Range not satisfiable', code: 'RAW_RANGE_INVALID' })
      )

    const start = parsed ? parsed.start : 0
    const end = parsed ? parsed.end : Math.max(0, info.size - 1)
    const length = info.size === 0 ? 0 : end - start + 1
    if (parsed) {
      reply.status(206)
      reply.header('Content-Range', `bytes ${start}-${end}/${info.size}`)
    }
    reply.header('Content-Length', String(length))
    if (length === 0) return reply.send(Buffer.alloc(0))
    // HEAD 交给 Fastify 会把 Content-Length 改写成 0；直接接管 raw 响应保留真实长度
    if (request.method === 'HEAD') {
      reply.hijack()
      // getHeaders() 的值类型比 OutgoingHttpHeaders 宽（含 boolean），这里已全部是字符串
      reply.raw.writeHead(reply.statusCode, reply.getHeaders() as Record<string, string>)
      reply.raw.end()
      return reply
    }

    // 客户端断开时同时掐掉 SSH/agent 子进程，别让远端继续读大文件
    const controller = new AbortController()
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) controller.abort()
    })
    const rateLimitKBps = parseRawRateLimitKBps(query.rateLimitKBps)
    try {
      let body: Readable
      if (hostId === 'local') body = createReadStream(info.absolutePath, { start, end })
      else
        body = limitBytes(await getDownloadStream(hostId, info.absolutePath, false, controller.signal, start), length)
      if (rateLimitKBps > 0) body = body.pipe(createRateLimitStream(rateLimitKBps))
      return reply.send(body)
    } catch {
      return reply.status(502).send({ message: 'Upstream stream failed', code: 'RAW_UPSTREAM_FAILED' })
    }
  })
}
