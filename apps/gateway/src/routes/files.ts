import type { FastifyInstance } from 'fastify'
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
    const query = request.query as { root?: string; path?: string }
    return listDirectoryForHost(hostId, query.root || '', query.path || '')
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
    const query = request.query as { root?: string; q?: string; basePath?: string; includeDotFiles?: string }
    return searchContentForHost(
      hostId,
      query.root || '',
      query.q || '',
      query.basePath || '',
      query.includeDotFiles !== 'false',
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
    for await (const part of parts) {
      if (part.type === 'file') {
        if (!targetRootId) throw new Error('Missing target root')
        if (conflictPolicy !== 'rename') throw new Error('Unsupported conflict policy')
        const safeName = sanitizeUploadFileName(part.filename)
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
      if (!stagedFiles.length) throw new Error('No files uploaded')
      return reply.status(202).send({
        task: await backgroundTasks.start({
          type: 'file-upload',
          title: `Upload ${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'}`,
          input: { hostId, targetRootId, targetPath, conflictPolicy, rateLimitKBps, files: stagedFiles },
        }),
      })
    }
    if (!resolvedTarget) throw new Error('No files uploaded')
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
}
