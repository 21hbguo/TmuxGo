import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { execFile, spawn } from 'child_process'
import os from 'os'
import path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { mkdir, opendir, rename, rm, stat, unlink } from 'fs/promises'
import { readFile as readPreferencesFile } from 'fs/promises'
import { emitPluginEvent } from '../plugin-manager.js'
import { isPathInside } from '../file-path.js'
import { assertTargetAllowed } from '../tmux-policy.js'
import {
  getRemoteFileHost,
  normalizeRemoteFileErrorMessage,
  quoteRemoteFileShellValue,
  spawnRemoteFileCommand,
} from '../remote-file-command.js'
import { taskManager, type TaskExecutionContext, type TaskManager } from '../task-manager.js'
import { agentManager } from '../../agent-manager.js'
import { fileExists, getRoots, resolveFileForHost, resolveInside, runRemoteFileJson, toRelative } from './file-roots.js'
import {
  DEFAULT_DOWNLOAD_ARTIFACT_CLEANUP_INTERVAL_MS,
  DEFAULT_DOWNLOAD_ARTIFACT_MAX_BYTES,
  DEFAULT_DOWNLOAD_ARTIFACT_MAX_COUNT,
  DEFAULT_DOWNLOAD_ARTIFACT_TTL_MS,
  DEFAULT_UPLOAD_DIR,
  DEFAULT_UPLOAD_RATE_LIMIT_KBPS,
  IMAGE_MIME_BY_EXT,
  MAX_UPLOAD_RATE_LIMIT_KBPS,
  readPositiveIntegerEnv,
  type BackgroundDownloadInput,
  type BackgroundUploadInput,
  type FileRoot,
  type StagedUploadFile,
} from './file-types.js'
const execFileAsync = promisify(execFile)
function getFallbackRoot(roots: FileRoot[]) {
  return roots.find((item) => item.label.toLowerCase() === 'workspace') || roots[0]
}
function mapAbsolutePathToRoot(roots: FileRoot[], absolutePath: string) {
  const sortedRoots = [...roots].sort((a, b) => b.path.length - a.path.length)
  return sortedRoots.find((root) => isPathInside(root.path, absolutePath)) || null
}
async function getPaneCurrentPath(paneId: string) {
  await assertTargetAllowed(paneId)
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}'])
  return stdout.trim()
}
export async function resolveDefaultUploadTarget(paneId?: string) {
  const roots = await getRoots()
  const fallbackRoot = getFallbackRoot(roots)
  if (paneId) {
    try {
      const cwd = await getPaneCurrentPath(paneId)
      const matchedRoot = mapAbsolutePathToRoot(roots, cwd)
      if (matchedRoot) {
        const relativePath = toRelative(matchedRoot.path, cwd)
        return {
          rootId: matchedRoot.id,
          rootLabel: matchedRoot.label,
          rootPath: matchedRoot.path,
          path: relativePath,
          absolutePath: cwd,
          source: 'pane' as const,
        }
      }
    } catch {}
  }
  const absolutePath = path.join(fallbackRoot.path, DEFAULT_UPLOAD_DIR)
  return {
    rootId: fallbackRoot.id,
    rootLabel: fallbackRoot.label,
    rootPath: fallbackRoot.path,
    path: DEFAULT_UPLOAD_DIR,
    absolutePath,
    source: 'fallback' as const,
  }
}
export function sanitizeUploadFileName(filename: string) {
  const normalized = path
    .basename(filename || '')
    .replace(/\0/g, '')
    .trim()
  if (!normalized || normalized === '.' || normalized === '..') throw new Error('Invalid file name')
  return normalized
}
export async function resolveUploadDestination(directoryPath: string, fileName: string) {
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
export function normalizeUploadRateLimitKBps(input: unknown) {
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : NaN
  if (!Number.isFinite(value)) return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  return Math.max(1, Math.min(MAX_UPLOAD_RATE_LIMIT_KBPS, Math.round(value)))
}
export async function readStoredUploadRateLimitKBps(profile = 'default') {
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
async function readStoredDownloadRateLimitKBps(profile = 'default') {
  const preferencesDir = process.env.TMUXGO_PREFERENCES_DIR || path.join(os.homedir(), '.tmuxgo', 'preferences')
  const file = path.join(preferencesDir, `${profile}.json`)
  try {
    const content = await readPreferencesFile(file, 'utf8')
    const parsed = JSON.parse(content)
    return normalizeUploadRateLimitKBps(parsed?.downloadRateLimitKBps)
  } catch {
    return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  }
}
export function createRateLimitStream(rateLimitKBps: number) {
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
export async function resolveDownloadRateLimitKBps(queryRateLimitKBps?: unknown, profile = 'default') {
  const value =
    typeof queryRateLimitKBps === 'number'
      ? queryRateLimitKBps
      : typeof queryRateLimitKBps === 'string' && queryRateLimitKBps.trim()
        ? Number(queryRateLimitKBps)
        : NaN
  if (Number.isFinite(value)) return normalizeUploadRateLimitKBps(value)
  return readStoredDownloadRateLimitKBps(profile)
}
export function getImageMimeType(filePath: string) {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || ''
}
async function waitForProcess(child: ReturnType<typeof spawn>, fallback: string) {
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(normalizeRemoteFileErrorMessage(stderr, fallback))),
    )
  })
}
export async function writeRemoteUpload(
  hostId: string,
  absolutePath: string,
  source: NodeJS.ReadableStream,
  rateLimitKBps: number,
  signal?: AbortSignal,
  progress?: Transform,
) {
  if (agentManager.getAgent(hostId)) {
    const throttled = progress
      ? source.pipe(progress).pipe(createRateLimitStream(rateLimitKBps))
      : source.pipe(createRateLimitStream(rateLimitKBps))
    await agentManager.uploadFile(hostId, absolutePath, throttled as AsyncIterable<Buffer>, signal)
    return
  }
  const host = await getRemoteFileHost(hostId)
  const script = `import os,pathlib,sys;p=pathlib.Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True);t=p.with_name('.tmuxgo-upload-'+str(os.getpid()));f=t.open('wb');\nwhile True:\n b=sys.stdin.buffer.read(1024*1024)\n if not b: break\n f.write(b)\nf.close();os.replace(t,p)`
  const child = await spawnRemoteFileCommand(
    host,
    `python3 -c ${quoteRemoteFileShellValue(script)} -- ${quoteRemoteFileShellValue(absolutePath)}`,
    signal,
  )
  const completion = waitForProcess(child, 'Remote upload failed')
  try {
    if (progress) await pipeline(source, progress, createRateLimitStream(rateLimitKBps), child.stdin!, { signal })
    else await pipeline(source, createRateLimitStream(rateLimitKBps), child.stdin!, { signal })
    await completion
  } catch (error) {
    await completion.catch(() => {})
    throw error
  }
}
function getDownloadProcessStream(child: ReturnType<typeof spawn>, fallback: string) {
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  child.once('error', (error) => child.stdout?.destroy(error))
  child.once('close', (code) => {
    if (code !== 0) child.stdout?.destroy(new Error(normalizeRemoteFileErrorMessage(stderr, fallback)))
  })
  return child.stdout!
}
export async function getDownloadStream(
  hostId: string,
  absolutePath: string,
  directory: boolean,
  signal?: AbortSignal,
) {
  const archiveScript = `import os,pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1]);z=zipfile.ZipFile(sys.stdout.buffer,'w',zipfile.ZIP_DEFLATED)\nfor root,dirs,files in os.walk(p):\n for name in files:\n  item=pathlib.Path(root)/name;z.write(item,str(pathlib.Path(p.name)/item.relative_to(p)))\nz.close()`
  const fileScript = `import pathlib,sys;f=pathlib.Path(sys.argv[1]).open('rb')\nwhile True:\n b=f.read(1024*1024)\n if not b: break\n sys.stdout.buffer.write(b)`
  if (hostId === 'local')
    return getDownloadProcessStream(
      spawn('python3', ['-c', directory ? archiveScript : fileScript, absolutePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      }),
      'Download failed',
    )
  const host = await getRemoteFileHost(hostId)
  const child = await spawnRemoteFileCommand(
    host,
    `python3 -c ${quoteRemoteFileShellValue(directory ? archiveScript : fileScript)} -- ${quoteRemoteFileShellValue(absolutePath)}`,
    signal,
  )
  return getDownloadProcessStream(child, 'Remote download failed')
}
function getUploadStagingDir() {
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'upload-staging')
}
function createTransferProgressStream(onChunk: (size: number) => void) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      onChunk(chunk.length)
      callback(null, chunk)
    },
  })
}
export async function stageUploadFile(source: NodeJS.ReadableStream, fileName: string, rateLimitKBps: number) {
  const stagingDir = getUploadStagingDir()
  await mkdir(stagingDir, { recursive: true, mode: 0o700 })
  const stagedPath = path.join(stagingDir, randomUUID())
  await pipeline(source, createRateLimitStream(rateLimitKBps), createWriteStream(stagedPath, { mode: 0o600 }))
  const info = await stat(stagedPath)
  return { name: fileName, stagedPath, size: info.size }
}
export async function runBackgroundUploadTask(input: unknown, context: TaskExecutionContext) {
  const task = input as BackgroundUploadInput
  if (task.conflictPolicy !== 'rename') throw new Error('Unsupported conflict policy')
  const totalBytes = task.files.reduce((sum, file) => sum + file.size, 0)
  let transferredBytes = task.files.reduce((sum, file) => sum + (file.uploaded?.size || 0), 0)
  const startedAt = Date.now()
  const reportProgress = (size: number) => {
    transferredBytes += size
    const elapsedMs = Math.max(1, Date.now() - startedAt)
    context.setProgress(totalBytes ? (transferredBytes * 100) / totalBytes : 100, (transferredBytes * 1000) / elapsedMs)
  }
  let resolvedTarget: { root: FileRoot; absolutePath: string; relativePath: string } | null = null
  for (const file of task.files) {
    if (file.uploaded) continue
    if (context.signal.aborted) throw new Error('Task cancelled')
    if (!file.destination) {
      if (task.hostId === 'local') {
        if (!resolvedTarget) {
          resolvedTarget = await resolveInside(task.targetRootId, task.targetPath)
          await mkdir(resolvedTarget.absolutePath, { recursive: true })
        }
        const destination = await resolveUploadDestination(resolvedTarget.absolutePath, file.name)
        file.destination = {
          name: destination.candidateName,
          path: toRelative(resolvedTarget.root.path, destination.candidatePath),
          absolutePath: destination.candidatePath,
        }
      } else {
        const prepared = await runRemoteFileJson<{
          root: FileRoot
          directoryPath: string
          directoryAbsolutePath: string
          name: string
          path: string
          absolutePath: string
        }>(task.hostId, { op: 'prepare-upload', root: task.targetRootId, path: task.targetPath, name: file.name })
        if (!resolvedTarget)
          resolvedTarget = {
            root: prepared.root,
            absolutePath: prepared.directoryAbsolutePath,
            relativePath: prepared.directoryPath,
          }
        file.destination = { name: prepared.name, path: prepared.path, absolutePath: prepared.absolutePath }
      }
      context.checkpoint()
    }
    const destination = file.destination
    if (task.hostId === 'local') {
      if (!resolvedTarget) {
        resolvedTarget = await resolveInside(task.targetRootId, task.targetPath)
        await mkdir(resolvedTarget.absolutePath, { recursive: true })
      }
      const temporaryPath = path.join(resolvedTarget.absolutePath, `.${destination.name}.tmuxgo-upload-${randomUUID()}`)
      try {
        await pipeline(
          createReadStream(file.stagedPath),
          createTransferProgressStream(reportProgress),
          createRateLimitStream(task.rateLimitKBps),
          createWriteStream(temporaryPath),
          { signal: context.signal },
        )
        await rename(temporaryPath, destination.absolutePath)
      } catch (error) {
        await unlink(temporaryPath).catch(() => {})
        throw error
      }
    } else {
      await writeRemoteUpload(
        task.hostId,
        destination.absolutePath,
        createReadStream(file.stagedPath),
        task.rateLimitKBps,
        context.signal,
        createTransferProgressStream(reportProgress),
      )
    }
    file.uploaded = { ...destination, size: file.size }
    context.checkpoint()
    context.appendLog(`Uploaded ${file.uploaded.name}`)
    context.setProgress(totalBytes ? (transferredBytes * 100) / totalBytes : 100)
  }
  await Promise.all(task.files.map((file) => unlink(file.stagedPath).catch(() => {})))
  const files = task.files.map((file) => file.uploaded!).filter(Boolean)
  if (resolvedTarget)
    emitPluginEvent('file.uploaded', {
      hostId: task.hostId,
      rootId: resolvedTarget.root.id,
      filePath: resolvedTarget.relativePath,
      files: files.map((file) => ({ name: file.name, path: file.path, size: file.size })),
    })
  return { message: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`, result: { files } }
}
export function getDownloadArtifactDir() {
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'download-artifacts')
}
export function getDownloadArtifactPath(artifactId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(artifactId)) throw new Error('Invalid download artifact')
  return path.join(getDownloadArtifactDir(), artifactId)
}
function getRecentDownloadArtifactIds(backgroundTasks: TaskManager, now: number, ttlMs: number) {
  const cutoff = now - ttlMs
  const artifactIds = new Set<string>()
  for (const task of backgroundTasks.list()) {
    if (task.type !== 'file-download' || task.status !== 'success' || !task.finishedAt) continue
    const finishedAt = Date.parse(task.finishedAt)
    if (!Number.isFinite(finishedAt) || finishedAt < cutoff) continue
    const result = task.result
    const downloadUrl = result && typeof result === 'object' ? (result as { downloadUrl?: unknown }).downloadUrl : null
    if (typeof downloadUrl !== 'string') continue
    const match = downloadUrl.match(/\/files\/download-tasks\/([a-f0-9-]{36})$/i)
    if (match) artifactIds.add(match[1])
  }
  return artifactIds
}
export async function cleanupExpiredDownloadArtifacts(now = Date.now(), backgroundTasks: TaskManager = taskManager) {
  const ttlMs = readPositiveIntegerEnv('TMUXGO_DOWNLOAD_ARTIFACT_TTL_MS', DEFAULT_DOWNLOAD_ARTIFACT_TTL_MS)
  const maxCount = readPositiveIntegerEnv('TMUXGO_DOWNLOAD_ARTIFACT_MAX_COUNT', DEFAULT_DOWNLOAD_ARTIFACT_MAX_COUNT)
  const maxBytes = readPositiveIntegerEnv('TMUXGO_DOWNLOAD_ARTIFACT_MAX_BYTES', DEFAULT_DOWNLOAD_ARTIFACT_MAX_BYTES)
  const protectedIds = getRecentDownloadArtifactIds(backgroundTasks, now, ttlMs)
  let directory
  try {
    directory = await opendir(getDownloadArtifactDir())
  } catch {
    return
  }
  const entries: { name: string; entryPath: string; size: number; mtimeMs: number }[] = []
  for await (const entry of directory) {
    const entryPath = path.join(getDownloadArtifactDir(), entry.name)
    try {
      const info = await stat(entryPath)
      if (!info.isFile()) continue
      const temporary = /^[a-f0-9-]{36}\.tmp-[a-f0-9-]{36}$/i.test(entry.name)
      if (temporary && now - info.mtimeMs > ttlMs) {
        await rm(entryPath, { force: true })
        continue
      }
      if (!temporary) entries.push({ name: entry.name, entryPath, size: info.size, mtimeMs: info.mtimeMs })
    } catch {}
  }
  const retained: typeof entries = []
  for (const entry of entries) {
    if (now - entry.mtimeMs > ttlMs && !protectedIds.has(entry.name)) {
      try {
        await rm(entry.entryPath, { force: true })
      } catch {
        retained.push(entry)
      }
      continue
    }
    retained.push(entry)
  }
  let totalBytes = retained.reduce((sum, entry) => sum + entry.size, 0)
  let count = retained.length
  const removable = retained
    .filter((entry) => !protectedIds.has(entry.name))
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
  for (const entry of removable) {
    if (count <= maxCount && totalBytes <= maxBytes) break
    try {
      await rm(entry.entryPath, { force: true })
      count -= 1
      totalBytes -= entry.size
    } catch {}
  }
}
let downloadArtifactCleanupTimer: NodeJS.Timeout | null = null
let downloadArtifactCleanupManager: TaskManager = taskManager
export function startDownloadArtifactCleanup(backgroundTasks: TaskManager) {
  downloadArtifactCleanupManager = backgroundTasks
  if (downloadArtifactCleanupTimer) return
  void cleanupExpiredDownloadArtifacts(Date.now(), downloadArtifactCleanupManager)
  const intervalMs = readPositiveIntegerEnv(
    'TMUXGO_DOWNLOAD_ARTIFACT_CLEANUP_INTERVAL_MS',
    DEFAULT_DOWNLOAD_ARTIFACT_CLEANUP_INTERVAL_MS,
  )
  downloadArtifactCleanupTimer = setInterval(
    () => void cleanupExpiredDownloadArtifacts(Date.now(), downloadArtifactCleanupManager),
    intervalMs,
  )
  downloadArtifactCleanupTimer.unref?.()
}
export async function runBackgroundDownloadTask(input: unknown, context: TaskExecutionContext) {
  const task = input as BackgroundDownloadInput
  const fileInfo = await resolveFileForHost(task.hostId, task.rootId, task.path)
  const directory = !fileInfo.isFile
  const resumable = task.hostId === 'local' && fileInfo.isFile
  const fileName = directory ? `${path.basename(fileInfo.absolutePath)}.zip` : path.basename(fileInfo.absolutePath)
  const artifactPath = getDownloadArtifactPath(task.artifactId)
  const temporaryPath = `${artifactPath}.tmp`
  await mkdir(getDownloadArtifactDir(), { recursive: true, mode: 0o700 })
  let downloadSize = fileInfo.size
  let offset = 0
  if (resumable) {
    const sourceInfo = await stat(fileInfo.absolutePath)
    downloadSize = sourceInfo.size
    if (task.sourceSize !== sourceInfo.size || task.sourceModifiedAt !== sourceInfo.mtime.toISOString()) {
      task.sourceSize = sourceInfo.size
      task.sourceModifiedAt = sourceInfo.mtime.toISOString()
      task.downloadedBytes = 0
      await unlink(temporaryPath).catch(() => {})
      context.checkpoint()
    } else {
      try {
        const temporaryInfo = await stat(temporaryPath)
        if (temporaryInfo.isFile() && temporaryInfo.size <= sourceInfo.size) offset = temporaryInfo.size
        else await unlink(temporaryPath).catch(() => {})
      } catch {}
      task.downloadedBytes = offset
      context.checkpoint()
    }
  }
  const initialOffset = offset
  let checkpointBytes = initialOffset
  let transferredBytes = 0
  const startedAt = Date.now()
  const reportProgress = (size: number) => {
    transferredBytes += size
    const totalTransferredBytes = initialOffset + transferredBytes
    if (resumable) {
      task.downloadedBytes = totalTransferredBytes
      if (totalTransferredBytes - checkpointBytes >= 1024 * 1024) {
        checkpointBytes = totalTransferredBytes
        context.checkpoint()
      }
    }
    const elapsedMs = Math.max(1, Date.now() - startedAt)
    context.setProgress(
      fileInfo.isFile ? (totalTransferredBytes * 100) / downloadSize : null,
      (transferredBytes * 1000) / elapsedMs,
    )
  }
  try {
    const source = resumable
      ? createReadStream(fileInfo.absolutePath, offset ? { start: offset } : undefined)
      : task.hostId === 'local' && fileInfo.isFile
        ? createReadStream(fileInfo.absolutePath)
        : await getDownloadStream(task.hostId, fileInfo.absolutePath, directory, context.signal)
    await pipeline(
      source,
      createTransferProgressStream(reportProgress),
      createRateLimitStream(task.rateLimitKBps),
      createWriteStream(temporaryPath, { flags: resumable && offset ? 'a' : 'w', mode: 0o600 }),
      { signal: context.signal },
    )
    await rename(temporaryPath, artifactPath)
    if (resumable) {
      task.downloadedBytes = downloadSize
      context.checkpoint()
    }
  } catch (error) {
    if (!resumable) await unlink(temporaryPath).catch(() => {})
    throw error
  }
  const artifact = await stat(artifactPath)
  const downloadUrl = `/api/hosts/${encodeURIComponent(task.hostId)}/files/download-tasks/${task.artifactId}`
  context.appendLog(`Prepared ${fileName}`)
  return { message: `Prepared ${fileName}`, result: { downloadUrl, fileName, size: artifact.size } }
}
