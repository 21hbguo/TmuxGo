import '../test-env.js'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createUpdateChecker } from './update-checker.js'

// update-checker 全部外部依赖都是 git CLI：把假 git 前置进 PATH 后，
// 「fetch 成功/失败/超时、非仓库、git 缺失」都变成可断言的输入，不触网也不碰真实仓库。
// 桩只回放 argv→stdout 映射，未声明的调用一律 exit 127，避免用例偷偷依赖真实行为。
const GIT_SHIM = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.SHIM_GIT_LOG, JSON.stringify(args) + '\\n')
const spec = JSON.parse(readFileSync(process.env.SHIM_GIT_SPEC, 'utf8'))
const rule = (spec.rules || []).find((entry) => args.join(' ') === entry.args) || spec.fallback || {}
if (rule.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, rule.delayMs)
if (rule.code && rule.code !== 0) {
  process.stderr.write(rule.stderr || 'shim failure\\n')
  process.exit(rule.code)
}
process.stdout.write(rule.stdout || '')
process.exit(0)
`

type GitRule = { args: string; stdout?: string; code?: number; stderr?: string; delayMs?: number }
interface GitShim {
  rootDir: string
  calls: () => string[][]
  setRules: (rules: GitRule[], fallback?: GitRule) => void
  restore: () => void
}

function installGitShim(t: test.TestContext, rules: GitRule[]): GitShim {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-git-shim-'))
  const bin = path.join(dir, 'bin')
  const rootDir = path.join(dir, 'repo')
  mkdirSync(bin)
  mkdirSync(path.join(rootDir, 'apps/frontend'), { recursive: true })
  writeFileSync(path.join(rootDir, 'apps/frontend/package.json'), JSON.stringify({ version: '1.4.0' }))
  const gitPath = path.join(bin, 'git')
  writeFileSync(gitPath, GIT_SHIM)
  chmodSync(gitPath, 0o755)
  const log = path.join(dir, 'git.log')
  const specPath = path.join(dir, 'git-spec.json')
  writeFileSync(log, '')
  const setRules = (next: GitRule[], fallback?: GitRule) =>
    writeFileSync(specPath, JSON.stringify({ rules: next, fallback }))
  setRules(rules, { args: '*', code: 127, stderr: 'unexpected git call' })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath ?? '/usr/bin:/bin'}`
  process.env.SHIM_GIT_LOG = log
  process.env.SHIM_GIT_SPEC = specPath
  const shim: GitShim = {
    rootDir,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    setRules,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      delete process.env.SHIM_GIT_LOG
      delete process.env.SHIM_GIT_SPEC
      rmSync(dir, { recursive: true, force: true })
    },
  }
  t.after(() => shim.restore())
  return shim
}

const HAPPY_RULES: GitRule[] = [
  { args: 'rev-parse --abbrev-ref HEAD', stdout: 'master\n' },
  { args: 'rev-parse --short HEAD', stdout: 'abc1234\n' },
  { args: 'status --porcelain', stdout: '' },
  { args: 'rev-parse --abbrev-ref --symbolic-full-name @{u}', stdout: 'origin/master\n' },
  { args: 'fetch --quiet origin', stdout: '' },
  { args: 'rev-parse --short origin/master', stdout: 'def5678\n' },
  { args: 'rev-list --left-right --count HEAD...origin/master', stdout: '2\t5\n' },
  { args: 'show origin/master:apps/frontend/package.json', stdout: '{"version":"1.5.0"}' },
]

const countCalls = (shim: GitShim, args: string) => shim.calls().filter((call) => call.join(' ') === args).length

test('computes ahead/behind from rev-list counts and pairs local with remote ref', async (t) => {
  const shim = installGitShim(t, HAPPY_RULES)
  const checker = createUpdateChecker({ rootDir: shim.rootDir })
  const status = await checker.getStatus()

  assert.equal(status.available, true)
  assert.equal(status.branch, 'master')
  assert.equal(status.aheadBy, 2)
  assert.equal(status.behindBy, 5)
  assert.equal(status.dirty, false)
  assert.equal(status.error, null)
  assert.deepEqual(status.current, { version: '1.4.0', buildId: '1.4.0-abc1234', commit: 'abc1234' })
  // 远端版本号取自 show <ref>:apps/frontend/package.json，不是本地文件
  assert.deepEqual(status.latest, { version: '1.5.0', buildId: '1.5.0-def5678', commit: 'def5678' })
  assert.ok(status.checkedAt && !Number.isNaN(Date.parse(status.checkedAt)))
})

test('treats local-only commits as not available and reports dirty plus detached HEAD', async (t) => {
  const shim = installGitShim(t, [
    ...HAPPY_RULES.filter(
      (rule) =>
        ![
          'status --porcelain',
          'rev-parse --abbrev-ref HEAD',
          'rev-list --left-right --count HEAD...origin/master',
        ].includes(rule.args),
    ),
    // 分离 HEAD：rev-parse --abbrev-ref HEAD 打印 HEAD，实现应归一成 branch=null
    { args: 'rev-parse --abbrev-ref HEAD', stdout: 'HEAD\n' },
    { args: 'status --porcelain', stdout: ' M apps/gateway/src/routes/system.ts\n' },
    { args: 'rev-list --left-right --count HEAD...origin/master', stdout: '3\t0\n' },
  ])
  const checker = createUpdateChecker({ rootDir: shim.rootDir })
  const status = await checker.getStatus()

  assert.equal(status.available, false)
  assert.equal(status.branch, null)
  assert.equal(status.aheadBy, 3)
  assert.equal(status.behindBy, 0)
  assert.equal(status.dirty, true)
})

test('throttles git fetch by fetchMinIntervalMs and bypasses it when forced', async (t) => {
  const shim = installGitShim(t, HAPPY_RULES)
  const checker = createUpdateChecker({ rootDir: shim.rootDir, fetchMinIntervalMs: 45000 })

  await checker.getStatus()
  await checker.getStatus()
  assert.equal(countCalls(shim, 'fetch --quiet origin'), 1, '节流窗口内的第二次查询不得再 fetch')

  const forced = await checker.getStatus(true)
  assert.equal(countCalls(shim, 'fetch --quiet origin'), 2, 'force 必须重新 fetch')
  assert.equal(forced.behindBy, 5)
})

test('keeps the previous remote snapshot when a later fetch fails', async (t) => {
  const shim = installGitShim(t, HAPPY_RULES)
  const checker = createUpdateChecker({ rootDir: shim.rootDir })
  const first = await checker.getStatus()
  assert.equal(first.error, null)

  shim.setRules(
    HAPPY_RULES.map((rule) =>
      rule.args === 'fetch --quiet origin'
        ? { args: rule.args, code: 128, stderr: 'fatal: unable to access remote' }
        : rule,
    ),
  )
  const second = await checker.getStatus(true)
  assert.match(String(second.error), /unable to access remote/)
  // 缓存兜底：远端快照保留，available/behindBy 不得因一次 fetch 失败归零
  assert.equal(second.available, true)
  assert.equal(second.behindBy, 5)
  assert.deepEqual(second.latest, first.latest)
  assert.notEqual(second.checkedAt, null)
})

test('falls back to the upstream ref when the very first fetch fails', async (t) => {
  const shim = installGitShim(t, [
    ...HAPPY_RULES.map((rule) =>
      rule.args === 'fetch --quiet origin'
        ? { args: rule.args, code: 128, stderr: 'fatal: could not read from remote' }
        : rule,
    ),
  ])
  const checker = createUpdateChecker({ rootDir: shim.rootDir })
  const status = await checker.getStatus()

  assert.match(String(status.error), /could not read from remote/)
  assert.deepEqual(status.latest, { version: '1.5.0', buildId: '1.5.0-def5678', commit: 'def5678' })
  assert.equal(status.behindBy, 5)
})

test('times out a slow fetch without hanging the status call', async (t) => {
  const shim = installGitShim(t, [
    ...HAPPY_RULES.map((rule) =>
      rule.args === 'fetch --quiet origin' ? { args: rule.args, delayMs: 5000, stdout: '' } : rule,
    ),
  ])
  const checker = createUpdateChecker({ rootDir: shim.rootDir, fetchTimeoutMs: 300, fetchMinIntervalMs: 0 })
  const startedAt = Date.now()
  const status = await checker.getStatus()
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 3000, `fetch 超时后应立即返回，实际 ${elapsed}ms`)
  assert.ok(status.error, 'fetch 超时必须落到 error 字段')
  // 超时后仍走 stale 回退：本地能读到的引用照常给出
  assert.equal(status.behindBy, 5)
})

test('falls back to FETCH_HEAD when the branch has no upstream configured', async (t) => {
  const shim = installGitShim(t, [
    { args: 'rev-parse --abbrev-ref HEAD', stdout: 'feature/x\n' },
    { args: 'rev-parse --short HEAD', stdout: 'abc1234\n' },
    { args: 'status --porcelain', stdout: '' },
    { args: 'rev-parse --abbrev-ref --symbolic-full-name @{u}', code: 128, stderr: 'fatal: no upstream configured\n' },
    { args: 'rev-parse --verify origin/feature/x', code: 128, stderr: 'fatal: Needed a single revision\n' },
    { args: 'fetch --quiet origin feature/x', stdout: '' },
    { args: 'rev-parse --short FETCH_HEAD', stdout: 'fff0000\n' },
    { args: 'rev-list --left-right --count HEAD...FETCH_HEAD', stdout: '0\t4\n' },
    { args: 'show FETCH_HEAD:apps/frontend/package.json', stdout: '{"version":"1.6.0"}' },
  ])
  const checker = createUpdateChecker({ rootDir: shim.rootDir })
  const status = await checker.getStatus()

  assert.equal(status.branch, 'feature/x')
  assert.equal(status.aheadBy, 0)
  assert.equal(status.behindBy, 4)
  assert.equal(status.available, true)
  assert.deepEqual(status.latest, { version: '1.6.0', buildId: '1.6.0-fff0000', commit: 'fff0000' })
  assert.equal(status.error, null)
  assert.equal(countCalls(shim, 'fetch --quiet origin feature/x'), 1)
})

test('degrades to empty local state inside a non-repository directory', async (t) => {
  const shim = installGitShim(t, HAPPY_RULES)
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-not-a-repo-'))
  t.after(() => rmSync(emptyDir, { recursive: true, force: true }))
  // 这里刻意用真实 git：断言的是「不是仓库时 git 自己报错」的降级路径
  shim.restore()
  const checker = createUpdateChecker({ rootDir: emptyDir, fetchMinIntervalMs: 0 })
  const status = await checker.getStatus()

  assert.equal(status.branch, null)
  assert.equal(status.current.commit, '')
  assert.equal(status.current.version, 'dev')
  assert.equal(status.current.buildId, 'dev')
  assert.equal(status.latest, null)
  assert.equal(status.available, false)
  assert.equal(status.aheadBy, 0)
  assert.equal(status.behindBy, 0)
  // git 的报错文案随 LANG 本地化，只断言"命令失败被捕获成 error"，不绑文案
  assert.match(String(status.error), /Command failed: git/)
})

test('reports the failure instead of throwing when git is not installed', async (t) => {
  const shim = installGitShim(t, HAPPY_RULES)
  const emptyPath = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-no-git-'))
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }))
  process.env.PATH = emptyPath
  const checker = createUpdateChecker({ rootDir: shim.rootDir, fetchMinIntervalMs: 0 })
  const status = await checker.getStatus()

  assert.equal(status.branch, null)
  assert.equal(status.current.commit, '')
  assert.equal(status.current.version, '1.4.0', '本地版本号来自文件读取，不依赖 git')
  assert.equal(status.current.buildId, '1.4.0')
  assert.equal(status.latest, null)
  assert.match(String(status.error), /ENOENT|not found/i)
})
