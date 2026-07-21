import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'

test('copies, moves, trashes, restores and downloads directories', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-file-operations-'))
  const configDir = path.join(rootDir, '.config')
  await mkdir(path.join(rootDir, 'source'), { recursive: true })
  await mkdir(path.join(rootDir, 'copy-target'), { recursive: true })
  await mkdir(path.join(rootDir, 'move-target'), { recursive: true })
  await writeFile(path.join(rootDir, 'source', 'demo.txt'), 'demo')
  process.env.TMUX_WEB_FILE_ROOTS = `workspace=${rootDir}`
  process.env.TMUXGO_CONFIG_DIR = configDir
  const { fileRoutes } = await import('../apps/gateway/src/routes/files')
  const app = Fastify()
  await app.register(fileRoutes, { prefix: '/api' })
  t.after(async () => {
    await app.close()
    delete process.env.TMUX_WEB_FILE_ROOTS
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(rootDir, { recursive: true, force: true })
  })
  const copy = await app.inject({ method: 'POST', url: '/api/hosts/local/files/copy', payload: { root: 'root-0', path: 'source/demo.txt', targetRoot: 'root-0', targetPath: 'copy-target' } })
  assert.equal(copy.statusCode, 200)
  assert.equal(await readFile(path.join(rootDir, 'copy-target', 'demo.txt'), 'utf8'), 'demo')
  const move = await app.inject({ method: 'POST', url: '/api/hosts/local/files/move', payload: { root: 'root-0', path: 'copy-target/demo.txt', targetRoot: 'root-0', targetPath: 'move-target' } })
  assert.equal(move.statusCode, 200)
  await assert.rejects(() => stat(path.join(rootDir, 'copy-target', 'demo.txt')), /ENOENT/)
  const trash = await app.inject({ method: 'POST', url: '/api/hosts/local/files/trash', payload: { root: 'root-0', path: 'move-target/demo.txt' } })
  assert.equal(trash.statusCode, 200)
  const trashId = trash.json().entry.id
  const trashList = await app.inject({ method: 'GET', url: '/api/hosts/local/files/trash' })
  assert.equal(trashList.json().entries[0].id, trashId)
  const restore = await app.inject({ method: 'POST', url: '/api/hosts/local/files/restore', payload: { trashId } })
  assert.equal(restore.statusCode, 200)
  assert.equal(await readFile(path.join(rootDir, 'move-target', 'demo.txt'), 'utf8'), 'demo')
  const download = await app.inject({ method: 'GET', url: '/api/hosts/local/files/download?root=root-0&path=source&rateLimitKBps=10240' })
  assert.equal(download.statusCode, 200)
  assert.equal(download.headers['content-type'], 'application/zip')
  assert.equal(download.rawPayload.subarray(0, 2).toString(), 'PK')
})
