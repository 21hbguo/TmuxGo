import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import multipart from '../apps/gateway/node_modules/@fastify/multipart'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { cleanupExpiredDownloadArtifacts, cleanupExpiredTemporaryUploads, runBackgroundDownloadTask, TEMP_UPLOAD_ROOT_ID } from '../apps/gateway/src/routes/files'
import { TaskManager } from '../apps/gateway/src/lib/task-manager'
async function createUploadApp(tmpDir: string, taskManager?: TaskManager) {
  process.env.TMUXGO_TMP_DIR = tmpDir
  const { fileRoutes } = await import('../apps/gateway/src/routes/files')
  const app = Fastify()
  await app.register(multipart)
  await app.register(fileRoutes, { prefix: '/api', taskManager })
  return app
}
function multipartPayload(fields: Record<string, string>, files: Array<{ field: string; name: string; type: string; content: string }>) {
  const boundary = `tmuxgo-${Date.now()}`
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n${file.content}\r\n`))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }
}
test('temporary upload target stores pasted files under app tmp directory', async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-paste-upload-'))
  const app = await createUploadApp(tmpDir)
  t.after(async () => {
    await app.close()
    delete process.env.TMUXGO_TMP_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })
  const targetResponse = await app.inject({ method: 'GET', url: '/api/hosts/local/files/temporary-upload-target' })
  assert.equal(targetResponse.statusCode, 200)
  assert.equal(targetResponse.json().rootId, TEMP_UPLOAD_ROOT_ID)
  assert.equal(targetResponse.json().absolutePath, tmpDir)
  const body = multipartPayload({ targetRootId: TEMP_UPLOAD_ROOT_ID, targetPath: '', conflictPolicy: 'rename', rateLimitKBps: '10240' }, [{ field: 'files', name: 'pasted.png', type: 'image/png', content: 'png-data' }])
  const uploadResponse = await app.inject({ method: 'POST', url: '/api/hosts/local/files/upload', payload: body.payload, headers: body.headers })
  assert.equal(uploadResponse.statusCode, 200)
  const uploaded = uploadResponse.json().files[0]
  assert.equal(uploaded.absolutePath, path.join(tmpDir, 'pasted.png'))
  assert.equal(await readFile(uploaded.absolutePath, 'utf8'), 'png-data')
})
test('background upload stages files and records a completed task', async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-background-upload-'))
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-background-upload-config-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  const manager = new TaskManager({ statePath: path.join(configDir, 'tasks.json') })
  const app = await createUploadApp(tmpDir, manager)
  t.after(async () => {
    await app.close()
    delete process.env.TMUXGO_TMP_DIR
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(tmpDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  })
  const body = multipartPayload({ targetRootId: TEMP_UPLOAD_ROOT_ID, targetPath: '', conflictPolicy: 'rename', rateLimitKBps: '10240', background: 'true' }, [{ field: 'files', name: 'queued.txt', type: 'text/plain', content: 'queued-data' }])
  const response = await app.inject({ method: 'POST', url: '/api/hosts/local/files/upload', payload: body.payload, headers: body.headers })
  assert.equal(response.statusCode, 202)
  const taskId = response.json().task.id as string
  let task = manager.get(taskId)
  for (let attempt = 0; task?.status === 'running' && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    task = manager.get(taskId)
  }
  assert.equal(task?.status, 'success')
  assert.equal(task?.type, 'file-upload')
  assert.equal(task?.progress, 100)
  assert.deepEqual(task?.result, { files: [{ name: 'queued.txt', path: 'queued.txt', absolutePath: path.join(tmpDir, 'queued.txt'), size: 11 }] })
  assert.equal(await readFile(path.join(tmpDir, 'queued.txt'), 'utf8'), 'queued-data')
})
test('background upload retries without choosing a new destination', async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-background-upload-retry-'))
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-background-upload-retry-config-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  const manager = new TaskManager({ statePath: path.join(configDir, 'tasks.json') })
  const app = await createUploadApp(tmpDir, manager)
  t.after(async () => {
    await app.close()
    delete process.env.TMUXGO_TMP_DIR
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(tmpDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  })
  const firstStagedPath = path.join(configDir, 'first.staged')
  const secondStagedPath = path.join(configDir, 'second.staged')
  await writeFile(firstStagedPath, 'first-data')
  const started = await manager.start({ type: 'file-upload', title: 'Upload 2 files', input: { hostId: 'local', targetRootId: TEMP_UPLOAD_ROOT_ID, targetPath: '', conflictPolicy: 'rename', rateLimitKBps: 10240, files: [{ name: 'first.txt', stagedPath: firstStagedPath, size: 10 }, { name: 'second.txt', stagedPath: secondStagedPath, size: 11 }] } })
  let failed = manager.get(started.id)
  for (let attempt = 0; failed?.status === 'running' && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    failed = manager.get(started.id)
  }
  assert.equal(failed?.status, 'error')
  assert.equal(await readFile(path.join(tmpDir, 'first.txt'), 'utf8'), 'first-data')
  const stored = JSON.parse(await readFile(path.join(configDir, 'tasks.json'), 'utf8')) as { tasks: { input: { files: { destination?: { absolutePath?: string }; uploaded?: { absolutePath?: string } }[] } }[] }
  assert.equal(stored.tasks[0].input.files[0].destination?.absolutePath, path.join(tmpDir, 'first.txt'))
  assert.equal(stored.tasks[0].input.files[0].uploaded?.absolutePath, path.join(tmpDir, 'first.txt'))
  await writeFile(secondStagedPath, 'second-data')
  assert.equal((await manager.retry(started.id))?.status, 'running')
  let completed = manager.get(started.id)
  for (let attempt = 0; completed?.status === 'running' && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    completed = manager.get(started.id)
  }
  assert.equal(completed.status, 'success')
  assert.equal(await readFile(path.join(tmpDir, 'first.txt'), 'utf8'), 'first-data')
  assert.equal(await readFile(path.join(tmpDir, 'second.txt'), 'utf8'), 'second-data')
  await assert.rejects(() => stat(path.join(tmpDir, 'first (1).txt')), /ENOENT/)
  await assert.rejects(() => stat(path.join(tmpDir, 'second (1).txt')), /ENOENT/)
})
test('cleanupExpiredTemporaryUploads removes stale temporary files only', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-paste-cleanup-'))
  process.env.TMUXGO_TMP_DIR = tmpDir
  const oldPath = path.join(tmpDir, 'old.png')
  const freshPath = path.join(tmpDir, 'fresh.png')
  await writeFile(oldPath, 'old')
  await writeFile(freshPath, 'fresh')
  const now = Date.now()
  await import('node:fs/promises').then(({ utimes }) => Promise.all([
    utimes(oldPath, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000)),
    utimes(freshPath, new Date(now), new Date(now)),
  ]))
  try {
    await cleanupExpiredTemporaryUploads(now)
    await assert.rejects(() => stat(oldPath), /ENOENT/)
    assert.equal((await stat(freshPath)).isFile(), true)
  } finally {
    delete process.env.TMUXGO_TMP_DIR
    await rm(tmpDir, { recursive: true, force: true })
  }
})
test('cleanupExpiredDownloadArtifacts keeps recent task artifacts within retention bounds', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-download-artifact-cleanup-'))
  const artifactDir = path.join(configDir, 'download-artifacts')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(artifactDir, { recursive: true }))
  process.env.TMUXGO_CONFIG_DIR = configDir
  process.env.TMUXGO_DOWNLOAD_ARTIFACT_MAX_COUNT = '2'
  process.env.TMUXGO_DOWNLOAD_ARTIFACT_MAX_BYTES = '8'
  const manager = new TaskManager({ statePath: path.join(configDir, 'tasks.json') })
  const protectedId = '11111111-1111-4111-8111-111111111111'
  manager.register('file-download', async () => ({ result: { downloadUrl: `/api/hosts/local/files/download-tasks/${protectedId}` } }))
  const task = await manager.start({ type: 'file-download', title: 'Download protected', input: {} })
  let completed = manager.get(task.id)
  for (let attempt = 0; completed?.status === 'running' && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    completed = manager.get(task.id)
  }
  const stalePath = path.join(artifactDir, 'stale')
  const protectedPath = path.join(artifactDir, protectedId)
  const newestPath = path.join(artifactDir, 'newest')
  const oldestPath = path.join(artifactDir, 'oldest')
  await Promise.all([writeFile(stalePath, 'stale'), writeFile(protectedPath, 'keep'), writeFile(newestPath, 'new!'), writeFile(oldestPath, 'old!')])
  const now = Date.now()
  await import('node:fs/promises').then(({ utimes }) => Promise.all([
    utimes(stalePath, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000)),
    utimes(protectedPath, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000)),
    utimes(newestPath, new Date(now), new Date(now)),
    utimes(oldestPath, new Date(now - 60 * 1000), new Date(now - 60 * 1000)),
  ]))
  try {
    assert.equal(completed?.status, 'success')
    await cleanupExpiredDownloadArtifacts(now, manager)
    await assert.rejects(() => stat(stalePath), /ENOENT/)
    assert.equal((await stat(protectedPath)).isFile(), true)
    assert.equal((await stat(newestPath)).isFile(), true)
    await assert.rejects(() => stat(oldestPath), /ENOENT/)
  } finally {
    delete process.env.TMUXGO_CONFIG_DIR
    delete process.env.TMUXGO_DOWNLOAD_ARTIFACT_MAX_COUNT
    delete process.env.TMUXGO_DOWNLOAD_ARTIFACT_MAX_BYTES
    await rm(configDir, { recursive: true, force: true })
  }
})
test('local file download resumes from its retained temporary artifact', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-download-resume-config-'))
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-download-resume-source-'))
  const sourcePath = path.join(sourceDir, 'source.bin')
  const content = Buffer.alloc(4 * 1024 * 1024, 7)
  await writeFile(sourcePath, content)
  process.env.TMUXGO_CONFIG_DIR = configDir
  const artifactId = '22222222-2222-4222-8222-222222222222'
  const input = { hostId: 'local', rootId: `git:${encodeURIComponent(sourceDir)}`, path: 'source.bin', rateLimitKBps: 10240, artifactId }
  const controller = new AbortController()
  let aborted = false
  const firstContext = {
    signal: controller.signal,
    appendLog: () => {},
    setProgress: (progress: number | null) => {
      if (!aborted && progress !== null && progress >= 25) {
        aborted = true
        controller.abort()
      }
    },
    checkpoint: () => {},
  }
  try {
    await assert.rejects(() => runBackgroundDownloadTask(input, firstContext))
    const temporaryPath = path.join(configDir, 'download-artifacts', `${artifactId}.tmp`)
    const temporarySize = (await stat(temporaryPath)).size
    assert.ok(temporarySize > 0 && temporarySize < content.length)
    const result = await runBackgroundDownloadTask(input, { signal: new AbortController().signal, appendLog: () => {}, setProgress: () => {}, checkpoint: () => {} })
    assert.equal(result.result && typeof result.result === 'object' ? (result.result as { size?: number }).size : 0, content.length)
    assert.deepEqual(await readFile(path.join(configDir, 'download-artifacts', artifactId)), content)
  } finally {
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})
