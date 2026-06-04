import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import multipart from '../apps/gateway/node_modules/@fastify/multipart'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { cleanupExpiredTemporaryUploads, TEMP_UPLOAD_ROOT_ID } from '../apps/gateway/src/routes/files'
async function createUploadApp(tmpDir: string) {
  process.env.TMUXGO_TMP_DIR = tmpDir
  const { fileRoutes } = await import('../apps/gateway/src/routes/files')
  const app = Fastify()
  await app.register(multipart)
  await app.register(fileRoutes, { prefix: '/api' })
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
