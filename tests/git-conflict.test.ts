import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { gitRoutes } from '../apps/gateway/src/routes/git'

const execFileAsync = promisify(execFile)
test('resolves and continues a merge conflict', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-conflict-'))
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: repo })
  await git('init', '-b', 'main')
  await git('config', 'user.email', 'test@tmuxgo.local')
  await git('config', 'user.name', 'TmuxGo Test')
  await writeFile(path.join(repo, 'demo.txt'), 'base\n')
  await git('add', 'demo.txt')
  await git('commit', '-m', 'base')
  await git('checkout', '-b', 'feature')
  await writeFile(path.join(repo, 'demo.txt'), 'feature\n')
  await git('commit', '-am', 'feature')
  await git('checkout', 'main')
  await writeFile(path.join(repo, 'demo.txt'), 'main\n')
  await git('commit', '-am', 'main')
  await assert.rejects(() => git('merge', 'feature'))
  const app = Fastify()
  await app.register(gitRoutes, { prefix: '/api' })
  t.after(async () => {
    await app.close()
    await rm(repo, { recursive: true, force: true })
  })
  const status = await app.inject({ method: 'GET', url: `/api/hosts/local/git/status?path=${encodeURIComponent(repo)}` })
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().operation, 'merge')
  assert.deepEqual(status.json().conflicted.map((item: { path: string }) => item.path), ['demo.txt'])
  const resolve = await app.inject({ method: 'POST', url: '/api/hosts/local/git/resolve', payload: { path: repo, filePath: 'demo.txt', resolution: 'ours' } })
  assert.equal(resolve.statusCode, 200)
  assert.equal(await readFile(path.join(repo, 'demo.txt'), 'utf8'), 'main\n')
  const complete = await app.inject({ method: 'POST', url: '/api/hosts/local/git/operation', payload: { path: repo, operation: 'merge', action: 'continue' } })
  assert.equal(complete.statusCode, 200)
  const finalStatus = await app.inject({ method: 'GET', url: `/api/hosts/local/git/status?path=${encodeURIComponent(repo)}` })
  assert.equal(finalStatus.json().operation, null)
  assert.deepEqual(finalStatus.json().conflicted, [])
})
