import '../test-env.js'
import assert from 'node:assert/strict'
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import Fastify from 'fastify'
import test from 'node:test'
import { ZodError } from 'zod'
import { gitRoutes } from './git.js'

const execFileAsync = promisify(execFile)
async function runGit(repository: string, args: string[]) {
  return execFileAsync('git', ['-C', repository, ...args])
}
async function setup(t: test.TestContext) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-wt-'))
  const repository = path.join(configDir, 'repository')
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  await runGit(configDir, ['init', '-b', 'main', 'repository'])
  await runGit(repository, ['config', 'user.email', 'test@tmuxgo.dev'])
  await runGit(repository, ['config', 'user.name', 'TmuxGo Test'])
  await writeFile(path.join(repository, 'base.txt'), 'base\n')
  await runGit(repository, ['add', 'base.txt'])
  await runGit(repository, ['commit', '-m', 'Initial commit'])
  const fastify = Fastify()
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: error.message })
    return reply.send(error)
  })
  await fastify.register(gitRoutes)
  t.after(() => fastify.close())
  return { configDir, repository, fastify }
}

test('creates, lists and links worktrees with provenance', async (t) => {
  const { configDir, repository, fastify } = await setup(t)
  const worktreePath = path.join(configDir, 'wt-feature')
  const createResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees',
    payload: { path: repository, worktreePath, newBranch: 'feature' },
  })
  assert.equal(createResponse.statusCode, 200)
  const created = (createResponse.json() as any).worktree
  assert.equal(created.branch, 'feature')
  assert.match(created.commit, /^[0-9a-f]{40}$/)
  const listResponse = await fastify.inject({
    method: 'GET',
    url: `/hosts/local/git/worktrees?path=${encodeURIComponent(repository)}`,
  })
  const list = (listResponse.json() as any).worktrees
  assert.equal(list.length, 2)
  const entry = list.find((item: any) => item.path === worktreePath)
  assert.equal(entry.branch, 'feature')
  assert.equal(entry.provenance.id, created.id)
  const linkResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees/link',
    payload: { path: repository, worktreePath, sessionId: 'session-1', workspaceId: 'ws-1' },
  })
  assert.equal(linkResponse.statusCode, 200)
  assert.equal((linkResponse.json() as any).worktree.sessionId, 'session-1')
  const missingLink = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees/link',
    payload: { path: repository, worktreePath: path.join(configDir, 'nope'), sessionId: 'session-2' },
  })
  assert.equal((missingLink.json() as any).code, 'missing')
})

test('rejects unsafe paths and duplicate worktrees', async (t) => {
  const { configDir, repository, fastify } = await setup(t)
  for (const worktreePath of ['relative/wt', `${configDir}/../escape`, '--force']) {
    const response = await fastify.inject({
      method: 'POST',
      url: '/hosts/local/git/worktrees',
      payload: { path: repository, worktreePath },
    })
    assert.notEqual(response.statusCode, 200, worktreePath)
  }
  const badBranch = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees',
    payload: { path: repository, worktreePath: path.join(configDir, 'wt-bad'), newBranch: '--upload-pack=evil' },
  })
  assert.notEqual(badBranch.statusCode, 200)
  const worktreePath = path.join(configDir, 'wt-dup')
  const first = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees',
    payload: { path: repository, worktreePath },
  })
  assert.equal(first.statusCode, 200)
  const second = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees',
    payload: { path: repository, worktreePath },
  })
  assert.notEqual(second.statusCode, 200)
})

test('remove reports dirty worktree, honors force and keeps the branch', async (t) => {
  const { configDir, repository, fastify } = await setup(t)
  const worktreePath = path.join(configDir, 'wt-dirty')
  await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees',
    payload: { path: repository, worktreePath, newBranch: 'dirty-branch' },
  })
  await writeFile(path.join(worktreePath, 'dirty.txt'), 'uncommitted\n')
  const dirtyResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees/remove',
    payload: { path: repository, worktreePath },
  })
  assert.equal((dirtyResponse.json() as any).code, 'dirty')
  const forceResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees/remove',
    payload: { path: repository, worktreePath, force: true },
  })
  assert.equal((forceResponse.json() as any).ok, true)
  // 删除 worktree 不删除分支（显式红线）
  const { stdout } = await runGit(repository, ['branch', '--list', 'dirty-branch'])
  assert.equal(stdout.trim(), 'dirty-branch')
  const removeAgain = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/worktrees/remove',
    payload: { path: repository, worktreePath },
  })
  assert.equal((removeAgain.json() as any).code, 'missing')
})

test('surfaces remote errors for unknown hosts', async (t) => {
  const { repository, fastify } = await setup(t)
  const response = await fastify.inject({
    method: 'GET',
    url: `/hosts/no-such-host/git/worktrees?path=${encodeURIComponent(repository)}`,
  })
  assert.equal(response.statusCode, 500)
  assert.match((response.json() as any).message, /not found/i)
})
