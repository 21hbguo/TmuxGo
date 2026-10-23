// routes/git 的行为断言全部落在真 git 仓库上：端点做的是「读 git 输出 → 解析 → 拼参数 → 再写仓库」，
// 只测解析函数会漏掉参数拼接与状态机（stage/unstage/discard/merge 冲突）这类会伤用户仓库的路径。
// 每个用例 mkdtemp 独立仓库 + 独立 TMUXGO_CONFIG_DIR，绝不碰用户真实仓库与本机配置。
import '../test-env.js'
import assert from 'node:assert/strict'
import { execFile } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import Fastify, { type FastifyInstance } from 'fastify'
import test, { type TestContext } from 'node:test'
import { TaskManager } from '../lib/task-manager.js'
import { gitRoutes } from './git.js'

const execFileAsync = promisify(execFile)
function runGit(repository: string, args: string[]) {
  return execFileAsync('git', ['-C', repository, ...args])
}
async function runGitFailure(repository: string, args: string[]) {
  return execFileAsync('git', ['-C', repository, ...args]).then(
    () => null,
    (err: Error) => err,
  )
}
async function waitForTask(manager: TaskManager, id: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const task = manager.get(id)
    if (task && task.status !== 'running') return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Task did not finish')
}

interface Fixture {
  base: string
  repository: string
  fastify: FastifyInstance
  manager: TaskManager
}
// 基线仓库固定两个已提交文件（base.txt / a.txt），用例在此之上制造 staged/unstaged/rename/untracked
async function createFixture(t: TestContext): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-routes-'))
  const repository = path.join(base, 'repository')
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = path.join(base, 'config')
  const manager = new TaskManager({ statePath: path.join(base, 'tasks.json') })
  const fastify = Fastify()
  t.after(async () => {
    await fastify.close()
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(base, { recursive: true, force: true })
  })
  await runGit(base, ['init', '-b', 'main', 'repository'])
  await runGit(repository, ['config', 'user.email', 'test@tmuxgo.dev'])
  await runGit(repository, ['config', 'user.name', 'TmuxGo Test'])
  await runGit(repository, ['config', 'commit.gpgsign', 'false'])
  await writeFile(path.join(repository, 'base.txt'), 'base\n')
  await writeFile(path.join(repository, 'a.txt'), 'a\n')
  await runGit(repository, ['add', '.'])
  await runGit(repository, ['commit', '-m', 'Initial commit'])
  await fastify.register(gitRoutes, { taskManager: manager })
  return { base, repository, fastify, manager }
}
function file(repository: string, name: string) {
  return path.join(repository, name)
}
function inject(fixture: Fixture, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return fixture.fastify.inject({
    method,
    url: `/hosts/local/git/${url}`,
    ...(payload === undefined ? {} : { payload }),
  })
}
function body<T>(response: { json: () => unknown }) {
  return response.json() as T
}

test('runs commit and merge as persistent background tasks', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-route-'))
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
  const manager = new TaskManager({ statePath: path.join(configDir, 'tasks.json') })
  const fastify = Fastify()
  await fastify.register(gitRoutes, { taskManager: manager })
  await writeFile(path.join(repository, 'commit.txt'), 'commit\n')
  await runGit(repository, ['add', 'commit.txt'])
  const commitResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/commit',
    payload: { path: repository, message: 'Background commit', background: true },
  })
  assert.equal(commitResponse.statusCode, 202)
  const commitTaskId = (commitResponse.json() as { task: { id: string } }).task.id
  const commitTask = await waitForTask(manager, commitTaskId)
  assert.equal(commitTask.status, 'success')
  assert.equal(commitTask.type, 'git-commit')
  assert.equal(typeof (commitTask.result as { hash?: unknown })?.hash, 'string')
  await runGit(repository, ['checkout', '-b', 'feature'])
  await writeFile(path.join(repository, 'feature.txt'), 'feature\n')
  await runGit(repository, ['add', 'feature.txt'])
  await runGit(repository, ['commit', '-m', 'Feature'])
  await runGit(repository, ['checkout', 'main'])
  const mergeResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/merge',
    payload: { path: repository, branch: 'feature', background: true },
  })
  assert.equal(mergeResponse.statusCode, 202)
  const mergeTask = await waitForTask(manager, (mergeResponse.json() as { task: { id: string } }).task.id)
  assert.equal(mergeTask.status, 'success')
  assert.equal(mergeTask.type, 'git-merge')
  await fastify.close()
})
test('does not expose failed pull and push tasks for automatic retry', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-retry-'))
  const repository = path.join(configDir, 'repository')
  t.after(async () => {
    await rm(configDir, { recursive: true, force: true })
  })
  await runGit(configDir, ['init', '-b', 'main', 'repository'])
  const manager = new TaskManager({ statePath: path.join(configDir, 'tasks.json') })
  const fastify = Fastify()
  await fastify.register(gitRoutes, { taskManager: manager })
  const pullResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/pull',
    payload: { path: repository, background: true },
  })
  assert.equal(pullResponse.statusCode, 202)
  const pullTask = await waitForTask(manager, (pullResponse.json() as { task: { id: string } }).task.id)
  assert.equal(pullTask.status, 'error')
  assert.equal(pullTask.retryable, false)
  const pushResponse = await fastify.inject({
    method: 'POST',
    url: '/hosts/local/git/push',
    payload: { path: repository, background: true },
  })
  assert.equal(pushResponse.statusCode, 202)
  const pushTask = await waitForTask(manager, (pushResponse.json() as { task: { id: string } }).task.id)
  assert.equal(pushTask.status, 'error')
  assert.equal(pushTask.retryable, false)
  await fastify.close()
})

test('status splits staged, unstaged, renamed and untracked entries', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await writeFile(file(repository, 'staged.txt'), 'new\n')
  await runGit(repository, ['add', 'staged.txt'])
  await writeFile(file(repository, 'base.txt'), 'changed\n')
  await runGit(repository, ['mv', 'a.txt', 'b c.txt'])
  await writeFile(file(repository, 'untracked.txt'), 'u\n')
  // 路径含空格与引号：porcelain 解析按字段前缀切片，不能按空格 split 整个记录
  await writeFile(file(repository, `odd 'name'.txt`), 'x\n')

  const response = await inject(fixture, 'GET', 'status?path=' + encodeURIComponent(repository))
  assert.equal(response.statusCode, 200)
  const status = body<{
    branch: string
    ahead: number
    behind: number
    staged: Array<{ path: string; status: string; oldPath?: string; staged: boolean }>
    unstaged: Array<{ path: string; status: string; staged: boolean }>
    untracked: string[]
    conflicted: unknown[]
    operation: string | null
  }>(response)
  assert.equal(status.branch, 'main')
  assert.equal(status.ahead, 0)
  assert.equal(status.behind, 0)
  assert.equal(status.operation, null)
  assert.deepEqual(
    [...status.staged].sort((left, right) => left.path.localeCompare(right.path)),
    [
      { path: 'b c.txt', status: 'renamed', oldPath: 'a.txt', staged: true },
      { path: 'staged.txt', status: 'added', staged: true },
    ],
  )
  assert.deepEqual(status.unstaged, [{ path: 'base.txt', status: 'modified', staged: false }])
  assert.deepEqual(
    status.untracked,
    [`odd 'name'.txt`, 'untracked.txt'].sort((left, right) => left.localeCompare(right)),
  )
  assert.deepEqual(status.conflicted, [])
})

test('status reports an in-progress merge and operation abort restores a clean tree', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await runGit(repository, ['checkout', '-b', 'feat'])
  await writeFile(file(repository, 'base.txt'), 'feat-side\n')
  await runGit(repository, ['commit', '-am', 'feat change'])
  await runGit(repository, ['checkout', 'main'])
  await writeFile(file(repository, 'base.txt'), 'main-side\n')
  await runGit(repository, ['commit', '-am', 'main change'])
  assert.ok(await runGitFailure(repository, ['merge', 'feat']), 'merge must conflict')

  const conflictedResponse = await inject(fixture, 'GET', 'status?path=' + encodeURIComponent(repository))
  const conflicted = body<{ operation: string | null; conflicted: Array<{ path: string; status: string }> }>(
    conflictedResponse,
  )
  assert.equal(conflicted.operation, 'merge')
  assert.deepEqual(conflicted.conflicted, [{ path: 'base.txt', status: 'unmerged', staged: false }])

  const abort = await inject(fixture, 'POST', 'operation', { path: repository, operation: 'merge', action: 'abort' })
  assert.equal(abort.statusCode, 200)
  assert.deepEqual(
    { ...body<Record<string, unknown>>(abort), message: undefined },
    { ok: true, operation: 'merge', action: 'abort', message: undefined },
  )
  const after = await inject(fixture, 'GET', 'status?path=' + encodeURIComponent(repository))
  const clean = body<{ operation: string | null; conflicted: unknown[]; unstaged: unknown[] }>(after)
  assert.equal(clean.operation, null)
  assert.deepEqual(clean.conflicted, [])
  assert.deepEqual(clean.unstaged, [])
})

test('resolve ours plus operation continue finishes a conflicted merge', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await runGit(repository, ['checkout', '-b', 'feat'])
  await writeFile(file(repository, 'base.txt'), 'feat-side\n')
  await runGit(repository, ['commit', '-am', 'feat change'])
  await runGit(repository, ['checkout', 'main'])
  await writeFile(file(repository, 'base.txt'), 'main-side\n')
  await runGit(repository, ['commit', '-am', 'main change'])
  assert.ok(await runGitFailure(repository, ['merge', 'feat']))

  const resolve = await inject(fixture, 'POST', 'resolve', {
    path: repository,
    filePath: 'base.txt',
    resolution: 'ours',
  })
  assert.equal(resolve.statusCode, 200)
  assert.deepEqual(body<{ ok: boolean; filePath: string; resolution: string }>(resolve), {
    ok: true,
    filePath: 'base.txt',
    resolution: 'ours',
  })
  // core.editor=true：非交互环境下 --continue 不能等编辑器
  const continued = await inject(fixture, 'POST', 'operation', {
    path: repository,
    operation: 'merge',
    action: 'continue',
  })
  assert.equal(continued.statusCode, 200)
  assert.equal(body<{ ok: boolean; action: string }>(continued).action, 'continue')
  // 合并提交两个父节点 + 保留 ours 内容，证明确实走完了 merge --continue
  assert.equal((await runGit(repository, ['log', '-1', '--format=%P'])).stdout.trim().split(' ').length, 2)
  assert.equal((await readFile(file(repository, 'base.txt'), 'utf8')).trim(), 'main-side')
})

test('stage, unstage and discard only touch the requested tracked paths', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  const oddName = `sp ace 'q' --x.txt`
  await writeFile(file(repository, oddName), 'odd\n')
  const staged = await inject(fixture, 'POST', 'stage', { path: repository, filePaths: [oddName] })
  assert.equal(staged.statusCode, 200)
  assert.deepEqual(body<{ ok: boolean }>(staged), { ok: true })
  const stagedNames = await runGit(repository, ['diff', '--cached', '--name-only', '-z'])
  assert.deepEqual(stagedNames.stdout.split('\0').filter(Boolean), [oddName])

  const unstaged = await inject(fixture, 'POST', 'unstage', { path: repository, filePaths: [oddName] })
  assert.equal(unstaged.statusCode, 200)
  assert.equal((await runGit(repository, ['diff', '--cached', '--name-only'])).stdout.trim(), '')
  // porcelain 会给含空格的文件名加引号，改用 ls-files 判「已回到未跟踪」
  assert.equal((await runGit(repository, ['ls-files', '--others', '--exclude-standard'])).stdout.trim(), oddName)

  await writeFile(file(repository, 'base.txt'), 'dirty\n')
  const discard = await inject(fixture, 'POST', 'discard', { path: repository, filePaths: ['base.txt'] })
  assert.equal(discard.statusCode, 200)
  assert.equal((await readFile(file(repository, 'base.txt'), 'utf8')).trim(), 'base')

  // discard 未跟踪文件：git 拒绝（checkout -- 无此 pathspec），且文件绝不能被删掉
  const untrackedDiscard = await inject(fixture, 'POST', 'discard', { path: repository, filePaths: [oddName] })
  assert.equal(untrackedDiscard.statusCode, 500)
  assert.equal((await readFile(file(repository, oddName), 'utf8')).trim(), 'odd')
  assert.ok(await stat(file(repository, oddName)))
})

test('rejects file paths that escape the repository', async (t) => {
  const fixture = await createFixture(t)
  const traversal = await inject(fixture, 'POST', 'stage', { path: fixture.repository, filePaths: ['../outside.txt'] })
  assert.equal(traversal.statusCode, 500)
  assert.match(body<{ message: string }>(traversal).message, /Invalid file path/)
  const absolute = await inject(fixture, 'POST', 'discard', { path: fixture.repository, filePaths: ['/etc/passwd'] })
  assert.equal(absolute.statusCode, 500)
  assert.match(body<{ message: string }>(absolute).message, /Invalid file path/)
  assert.equal((await runGit(fixture.repository, ['status', '--porcelain'])).stdout.trim(), '')
})

test('commit returns the real short hash, keeps the message verbatim and amends in place', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await writeFile(file(repository, 'c.txt'), 'c\n')
  await runGit(repository, ['add', 'c.txt'])
  const message = `subject with 'quote' "--flag" $(nope)`
  const response = await inject(fixture, 'POST', 'commit', { path: repository, message })
  assert.equal(response.statusCode, 200)
  const committed = body<{ ok: boolean; hash: string; message: string }>(response)
  assert.equal(committed.ok, true)
  assert.equal(committed.message, message)
  assert.equal(committed.hash, (await runGit(repository, ['log', '-1', '--format=%h'])).stdout.trim())
  assert.equal((await runGit(repository, ['log', '-1', '--format=%s'])).stdout.trim(), message)

  const countBefore = (await runGit(repository, ['rev-list', '--count', 'HEAD'])).stdout.trim()
  const amended = await inject(fixture, 'POST', 'commit', { path: repository, message: 'amended subject', amend: true })
  assert.equal(amended.statusCode, 200)
  assert.equal((await runGit(repository, ['log', '-1', '--format=%s'])).stdout.trim(), 'amended subject')
  assert.equal((await runGit(repository, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore)
})

test('checkout switches branches and creates new ones, refusing invalid targets', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  const created = await inject(fixture, 'POST', 'create-branch', {
    path: repository,
    name: 'feature/x',
    startPoint: 'HEAD',
  })
  assert.equal(created.statusCode, 200)
  assert.deepEqual(body<{ ok: boolean; branch: string }>(created), { ok: true, branch: 'feature/x' })
  const duplicate = await inject(fixture, 'POST', 'create-branch', { path: repository, name: 'feature/x' })
  assert.equal(duplicate.statusCode, 500)

  const switched = await inject(fixture, 'POST', 'checkout', { path: repository, branch: 'feature/x' })
  assert.deepEqual(body<{ ok: boolean; branch: string }>(switched), { ok: true, branch: 'feature/x' })
  assert.equal((await runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'feature/x')

  const branched = await inject(fixture, 'POST', 'checkout', { path: repository, newBranch: 'topic', branch: 'main' })
  assert.deepEqual(body<{ ok: boolean; branch: string }>(branched), { ok: true, branch: 'topic' })
  assert.equal((await runGit(repository, ['merge-base', '--is-ancestor', 'main', 'topic'])).stderr, '')

  // 同名分支已存在：checkout -b 必须失败而不是静默切过去
  const conflictName = await inject(fixture, 'POST', 'checkout', { path: repository, newBranch: 'main' })
  assert.equal(conflictName.statusCode, 500)
  assert.equal((await runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'topic')

  const missing = await inject(fixture, 'POST', 'checkout', { path: repository, branch: 'no-such-branch' })
  assert.equal(missing.statusCode, 500)
  const missingBody = await inject(fixture, 'POST', 'checkout', { path: repository })
  assert.equal(missingBody.statusCode, 500)
  assert.match(body<{ message: string }>(missingBody).message, /Missing branch/)
})

test('delete-branch protects unmerged work unless force is set', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await runGit(repository, ['checkout', '-b', 'wip'])
  await writeFile(file(repository, 'wip.txt'), 'wip\n')
  await runGit(repository, ['add', 'wip.txt'])
  await runGit(repository, ['commit', '-m', 'wip commit'])
  await runGit(repository, ['checkout', 'main'])
  // 未合并分支：-d 拒绝，分支必须仍在（数据保护的关键断言）
  const refused = await inject(fixture, 'POST', 'delete-branch', { path: repository, name: 'wip' })
  assert.equal(refused.statusCode, 500)
  assert.equal((await runGit(repository, ['branch', '--list', 'wip'])).stdout.includes('wip'), true)
  const forced = await inject(fixture, 'POST', 'delete-branch', { path: repository, name: 'wip', force: true })
  assert.equal(forced.statusCode, 200)
  assert.deepEqual(body<{ ok: boolean }>(forced), { ok: true })
  assert.equal((await runGit(repository, ['branch', '--list', 'wip'])).stdout.trim(), '')
  // 当前分支不能删
  const current = await inject(fixture, 'POST', 'delete-branch', { path: repository, name: 'main', force: true })
  assert.equal(current.statusCode, 500)
  assert.equal((await runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main')
})

test('log parses bodies and parents, honours limit and skip', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await writeFile(file(repository, 'b.txt'), 'b\n')
  await runGit(repository, ['add', 'b.txt'])
  await runGit(repository, ['commit', '-m', 'second subject', '-m', 'body line 1\nbody line 2'])
  await runGit(repository, ['checkout', '-b', 'side'])
  await writeFile(file(repository, 's.txt'), 's\n')
  await runGit(repository, ['add', 's.txt'])
  await runGit(repository, ['commit', '-m', 'side commit'])
  await runGit(repository, ['checkout', 'main'])
  await writeFile(file(repository, 'm.txt'), 'm\n')
  await runGit(repository, ['add', 'm.txt'])
  await runGit(repository, ['commit', '-m', 'main commit'])
  await runGit(repository, ['merge', '--no-ff', '-m', 'merge side', 'side'])

  const all = await inject(fixture, 'GET', 'log?path=' + encodeURIComponent(repository))
  assert.equal(all.statusCode, 200)
  const first = body<{
    commits: Array<{
      hash: string
      shortHash: string
      subject: string
      body: string
      author: string
      parents: string[]
      date: string
    }>
    hasMore: boolean
  }>(all)
  assert.equal(first.hasMore, false)
  const merge = first.commits[0]
  assert.equal(merge.subject, 'merge side')
  assert.equal(merge.parents.length, 2)
  assert.equal(merge.shortHash, merge.hash.slice(0, 7))
  assert.equal(merge.author, 'TmuxGo Test')
  assert.match(merge.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/)
  const withBody = first.commits.find((commit) => commit.subject === 'second subject')
  assert.ok(withBody, 'second subject must be listed')
  assert.equal(withBody.body, 'body line 1\nbody line 2')

  const paged = await inject(fixture, 'GET', `log?path=${encodeURIComponent(repository)}&limit=1`)
  const page = body<{ commits: unknown[]; hasMore: boolean }>(paged)
  assert.equal(page.commits.length, 1)
  assert.equal(page.hasMore, true)
  const skipped = await inject(fixture, 'GET', `log?path=${encodeURIComponent(repository)}&limit=1&skip=1`)
  const second = body<{ commits: Array<{ hash: string }> }>(skipped).commits[0]
  assert.notEqual(second.hash, merge.hash)
  const missingPath = await inject(fixture, 'GET', 'log')
  assert.equal(missingPath.statusCode, 500)
  assert.match(body<{ message: string }>(missingPath).message, /Missing path parameter/)
})

test('branches, refs and remotes reflect tracking config and split push urls', async (t) => {
  const fixture = await createFixture(t)
  const { base, repository } = fixture
  const origin = path.join(base, 'origin.git')
  const pushOnly = path.join(base, 'push.git')
  // bare 仓库的默认分支要显式设成 main，否则 clone 出来的工作副本 HEAD 指向 master（未出生）
  await runGit(base, ['init', '--bare', '--initial-branch=main', 'origin.git'])
  await runGit(base, ['init', '--bare', '--initial-branch=main', 'push.git'])
  await runGit(repository, ['remote', 'add', 'origin', origin])
  await runGit(repository, ['remote', 'set-url', '--push', 'origin', pushOnly])
  await runGit(repository, ['push', '-u', 'origin', 'main'])
  await runGit(repository, ['tag', 'light-tag'])
  await runGit(repository, ['tag', '-a', 'annotated', '-m', 'annotated tag'])

  const branchesResponse = await inject(fixture, 'GET', 'branches?path=' + encodeURIComponent(repository))
  assert.equal(branchesResponse.statusCode, 200)
  const branches = body<{
    branches: Array<{ name: string; current: boolean; remote?: string; commitHash: string; lastCommitSubject: string }>
    refs: Array<{ name: string; kind: string; commitHash: string }>
    current: string
  }>(branchesResponse)
  assert.equal(branches.current, 'main')
  const main = branches.branches.find((branch) => branch.name === 'main')
  assert.ok(main)
  assert.equal(main.current, true)
  assert.equal(main.remote, 'origin/main')
  assert.equal(main.lastCommitSubject, 'Initial commit')
  assert.equal(main.commitHash.length, 40)
  // push -u 只建 refs/remotes/origin/main，origin/HEAD 是 clone 才有的符号引用
  assert.deepEqual(branches.refs.map((ref) => `${ref.kind}:${ref.name}`).sort(), [
    'remote:origin/main',
    'tag:annotated',
    'tag:light-tag',
  ])
  const head = (await runGit(repository, ['rev-parse', 'HEAD'])).stdout.trim()
  // annotated tag 指向 tag 对象，必须剥出 commit（peeled）
  assert.equal(branches.refs.find((ref) => ref.name === 'annotated')?.commitHash, head)

  const remotesResponse = await inject(fixture, 'GET', 'remotes?path=' + encodeURIComponent(repository))
  assert.equal(remotesResponse.statusCode, 200)
  assert.deepEqual(
    body<{ remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }> }>(remotesResponse).remotes,
    [{ name: 'origin', fetchUrl: origin, pushUrl: pushOnly }],
  )
})

test('diff-stats classifies modified, added and binary files', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  const baseCommit = (await runGit(repository, ['rev-parse', 'HEAD'])).stdout.trim()
  await writeFile(file(repository, 'base.txt'), 'base\nplus\nplus2\n')
  await writeFile(file(repository, 'added.txt'), 'new\n')
  // 二进制：numstat 输出 "-" 而不是行数
  await writeFile(file(repository, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
  await runGit(repository, ['add', '.'])
  await runGit(repository, ['commit', '-m', 'change set'])
  const headCommit = (await runGit(repository, ['rev-parse', 'HEAD'])).stdout.trim()

  const response = await inject(
    fixture,
    'GET',
    `diff-stats?path=${encodeURIComponent(repository)}&base=${baseCommit}&head=${headCommit}`,
  )
  assert.equal(response.statusCode, 200)
  const files = body<{ files: Array<{ filename: string; status: string; additions: number; deletions: number }> }>(
    response,
  ).files
  const byName = new Map(files.map((item) => [item.filename, item]))
  // numstat 只有行数，没有「改了原有行」的信息：纯增量改动的既有文件会被归为 added
  assert.deepEqual(byName.get('base.txt'), { filename: 'base.txt', status: 'added', additions: 2, deletions: 0 })
  assert.deepEqual(byName.get('added.txt'), { filename: 'added.txt', status: 'added', additions: 1, deletions: 0 })
  assert.equal(byName.get('bin.dat')?.status, 'binary')
  assert.equal(byName.get('bin.dat')?.additions, 0)

  const missing = await inject(fixture, 'GET', `diff-stats?path=${encodeURIComponent(repository)}`)
  assert.equal(missing.statusCode, 500)
  assert.match(body<{ message: string }>(missing).message, /Missing path, base or head/)
})

test('diff returns raw patches for staged, working tree, commit and untracked views', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await writeFile(file(repository, 'base.txt'), 'staged line\n')
  await runGit(repository, ['add', 'base.txt'])
  const staged = await inject(fixture, 'GET', `diff?path=${encodeURIComponent(repository)}&staged=true`)
  assert.match(body<{ raw: string }>(staged).raw, /\+staged line/)

  await writeFile(file(repository, 'base.txt'), 'staged line\nworktree line\n')
  const workingTree = await inject(fixture, 'GET', `diff?path=${encodeURIComponent(repository)}&workingTree=true`)
  assert.match(body<{ raw: string }>(workingTree).raw, /\+worktree line/)
  // 不带 staged 的 diff 就是「工作区相对索引」，必须带上未暂存改动
  const plain = await inject(fixture, 'GET', `diff?path=${encodeURIComponent(repository)}`)
  assert.match(body<{ raw: string }>(plain).raw, /\+worktree line/)
  assert.equal(body<{ raw: string }>(staged).raw.includes('worktree line'), false, 'staged diff ignores the worktree')

  await runGit(repository, ['commit', '-m', 'staged commit'])
  const head = (await runGit(repository, ['rev-parse', 'HEAD'])).stdout.trim()
  const show = await inject(fixture, 'GET', `diff?path=${encodeURIComponent(repository)}&commit=${head}`)
  assert.match(body<{ raw: string }>(show).raw, /\+staged line/)

  await writeFile(file(repository, 'fresh.txt'), 'fresh content\n')
  const untracked = await inject(
    fixture,
    'GET',
    `diff?path=${encodeURIComponent(repository)}&untracked=true&filePath=fresh.txt`,
  )
  assert.equal(untracked.statusCode, 200)
  assert.match(body<{ raw: string }>(untracked).raw, /\+fresh content/)

  const tracked = await inject(
    fixture,
    'GET',
    `diff?path=${encodeURIComponent(repository)}&untracked=true&filePath=base.txt`,
  )
  assert.equal(tracked.statusCode, 500)
  assert.match(body<{ message: string }>(tracked).message, /File is not untracked/)
  const traversal = await inject(
    fixture,
    'GET',
    `diff?path=${encodeURIComponent(repository)}&untracked=true&filePath=../etc`,
  )
  assert.equal(traversal.statusCode, 500)
  assert.match(body<{ message: string }>(traversal).message, /Invalid untracked file path/)
  const absolute = await inject(
    fixture,
    'GET',
    `diff?path=${encodeURIComponent(repository)}&untracked=true&filePath=/etc/passwd`,
  )
  assert.equal(absolute.statusCode, 500)
  assert.match(body<{ message: string }>(absolute).message, /Invalid untracked file path/)
})

test('detect resolves the repository root from a subdirectory and degrades to false', async (t) => {
  const fixture = await createFixture(t)
  const { base, repository } = fixture
  const nested = path.join(repository, 'nested', 'deeper')
  await mkdir(nested, { recursive: true })

  const fromNested = await inject(fixture, 'GET', `detect?path=${encodeURIComponent(nested)}`)
  assert.equal(fromNested.statusCode, 200)
  const detected = body<{ isGitRepo: boolean; rootPath: string; branch: string; path: string }>(fromNested)
  assert.equal(detected.isGitRepo, true)
  assert.equal(detected.rootPath, (await runGit(repository, ['rev-parse', '--show-toplevel'])).stdout.trim())
  assert.equal(detected.branch, 'main')
  assert.equal(detected.path, nested)

  const outside = await inject(fixture, 'GET', `detect?path=${encodeURIComponent(base)}`)
  assert.deepEqual(body<{ isGitRepo: boolean; path: string }>(outside), { isGitRepo: false, path: base })

  const empty = await inject(fixture, 'GET', 'detect')
  assert.deepEqual(body<{ isGitRepo: boolean }>(empty), { isGitRepo: false })
  // paneId 必须属于本 host 且形如 %N，否则直接降级为「不是仓库」而不是抛错
  const wrongHost = await inject(fixture, 'GET', 'detect?paneId=other-host:%1')
  assert.deepEqual(body<{ isGitRepo: boolean }>(wrongHost), { isGitRepo: false })
  const badPane = await inject(fixture, 'GET', 'detect?paneId=local:nope')
  assert.deepEqual(body<{ isGitRepo: boolean }>(badPane), { isGitRepo: false })
})

test('merge endpoint reports conflicts and fast-forwards as the disk state says', async (t) => {
  const fixture = await createFixture(t)
  const { repository } = fixture
  await runGit(repository, ['checkout', '-b', 'fast'])
  await writeFile(file(repository, 'fast.txt'), 'fast\n')
  await runGit(repository, ['add', 'fast.txt'])
  await runGit(repository, ['commit', '-m', 'fast commit'])
  await runGit(repository, ['checkout', 'main'])
  const fastForward = await inject(fixture, 'POST', 'merge', { path: repository, branch: 'fast' })
  assert.equal(fastForward.statusCode, 200)
  const ffBody = body<{ ok: boolean; fastForward: boolean; conflicts: boolean; message: string }>(fastForward)
  assert.equal(ffBody.ok, true)
  assert.equal(ffBody.fastForward, true)
  assert.equal(ffBody.conflicts, false)
  assert.match(ffBody.message, /Fast-forward/)

  await runGit(repository, ['checkout', '-b', 'clash'])
  await writeFile(file(repository, 'base.txt'), 'conflict side\n')
  await runGit(repository, ['commit', '-am', 'conflict side'])
  await runGit(repository, ['checkout', 'main'])
  await writeFile(file(repository, 'base.txt'), 'main side\n')
  await runGit(repository, ['commit', '-am', 'main side'])
  // 已知缺陷（本次只记录不改实现）：本机通道的 execGit 只用 stderr 组装错误文案，
  // 而 git merge 把 "CONFLICT (...)" 报表写在 stdout —— 于是端点拿到的是 Node 的
  // "Command failed: git merge clash"，conflicts 判定落空，冲突被当 500 抛出。
  // 分支名里带 "conflict" 字样时反而会因为子串命中而误判成 conflicts:true，
  // 所以这里刻意用不含该词的 'clash' 断言真实行为；修好 stdout 映射后本用例应改为 ok:false/conflicts:true。
  const conflicted = await inject(fixture, 'POST', 'merge', { path: repository, branch: 'clash' })
  assert.equal(conflicted.statusCode, 500)
  assert.match(body<{ message: string }>(conflicted).message, /Command failed: git merge clash/)
  // 冲突留在工作区，交给 operation abort 收尾（用户改主意时走这条路）
  const conflictedStatus = await inject(fixture, 'GET', 'status?path=' + encodeURIComponent(repository))
  assert.equal(body<{ operation: string | null }>(conflictedStatus).operation, 'merge')
  await runGit(repository, ['merge', '--abort'])
  const missingBranch = await inject(fixture, 'POST', 'merge', { path: repository })
  assert.equal(missingBranch.statusCode, 500)
  assert.match(body<{ message: string }>(missingBranch).message, /Missing path or branch/)
})

test('fetch and pull move the remote state into the working repository', async (t) => {
  const fixture = await createFixture(t)
  const { base, repository } = fixture
  const origin = path.join(base, 'origin.git')
  await runGit(base, ['init', '--bare', '--initial-branch=main', 'origin.git'])
  await runGit(repository, ['remote', 'add', 'origin', origin])
  await runGit(repository, ['push', '-u', 'origin', 'main'])
  // 另一份工作副本推进远端，模拟协作者
  const other = path.join(base, 'other')
  await runGit(base, ['clone', origin, 'other'])
  await runGit(other, ['config', 'user.email', 'other@tmuxgo.dev'])
  await runGit(other, ['config', 'user.name', 'Other'])
  await writeFile(file(other, 'remote.txt'), 'from-remote\n')
  await runGit(other, ['add', 'remote.txt'])
  await runGit(other, ['commit', '-m', 'remote commit'])
  await runGit(other, ['push', 'origin', 'main'])

  const fetched = await inject(fixture, 'POST', 'fetch', { path: repository, remote: 'origin', prune: true })
  assert.equal(fetched.statusCode, 200)
  assert.deepEqual(body<{ ok: boolean }>(fetched).ok, true)
  assert.equal(
    (await runGit(repository, ['rev-parse', 'origin/main'])).stdout.trim(),
    (await runGit(other, ['rev-parse', 'HEAD'])).stdout.trim(),
  )
  // fetch 后本地分支仍未移动（只更新远端跟踪引用）
  assert.equal(
    (await runGit(repository, ['rev-parse', 'HEAD'])).stdout.trim() !==
      (await runGit(repository, ['rev-parse', 'origin/main'])).stdout.trim(),
    true,
  )

  const pulled = await inject(fixture, 'POST', 'pull', { path: repository })
  assert.equal(pulled.statusCode, 200)
  const pullBody = body<{ ok: boolean; conflicts: boolean; message: string }>(pulled)
  assert.equal(pullBody.ok, true)
  assert.equal(pullBody.conflicts, false)
  assert.equal((await readFile(file(repository, 'remote.txt'), 'utf8')).trim(), 'from-remote')
})

test('push reports a rejected non-fast-forward instead of throwing', async (t) => {
  const fixture = await createFixture(t)
  const { base, repository } = fixture
  const origin = path.join(base, 'origin.git')
  await runGit(base, ['init', '--bare', '--initial-branch=main', 'origin.git'])
  await runGit(repository, ['remote', 'add', 'origin', origin])
  await runGit(repository, ['push', '-u', 'origin', 'main'])
  await writeFile(file(repository, 'ahead.txt'), 'ahead\n')
  await runGit(repository, ['add', 'ahead.txt'])
  await runGit(repository, ['commit', '-m', 'ahead commit'])
  await runGit(repository, ['push', 'origin', 'main'])
  const previousLocale = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
  process.env.LC_ALL = 'C'
  process.env.LANG = 'C'
  t.after(() => {
    if (previousLocale.LC_ALL === undefined) delete process.env.LC_ALL
    else process.env.LC_ALL = previousLocale.LC_ALL
    if (previousLocale.LANG === undefined) delete process.env.LANG
    else process.env.LANG = previousLocale.LANG
  })

  // 本地回退再提交：与远端分叉 → push 被拒（非快进），端点必须回 rejected 而不是 500
  await runGit(repository, ['reset', '--hard', 'HEAD~1'])
  await writeFile(file(repository, 'diverged.txt'), 'diverged\n')
  await runGit(repository, ['add', 'diverged.txt'])
  await runGit(repository, ['commit', '-m', 'diverged commit'])
  const rejected = await inject(fixture, 'POST', 'push', { path: repository })
  assert.equal(rejected.statusCode, 200)
  const rejectedBody = body<{ ok: boolean; rejected: boolean; message: string }>(rejected)
  assert.equal(rejectedBody.ok, false)
  assert.equal(rejectedBody.rejected, true)
  assert.match(rejectedBody.message, /rejected|failed to push/)

  const missing = await inject(fixture, 'POST', 'push', {})
  assert.equal(missing.statusCode, 500)
  assert.match(body<{ message: string }>(missing).message, /Missing path/)
})
