import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ci.yml 静态契约测试（无 yaml 依赖，按结构片段断言）：
// 锁住 merge gate 依赖链、e2e 门禁化、artifact 脱敏、ssh-e2e 无 secret 优雅跳过
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

function jobBlock(jobName: string) {
  // 切出 "  <job>:" 到下一个同级 job 的片段
  const start = ci.indexOf(`  ${jobName}:`)
  assert.ok(start >= 0, `ci.yml missing job ${jobName}`)
  const rest = ci.slice(start + 1)
  const next = rest.search(/^ {2}[a-zA-Z][\w-]*:/m)
  return next === -1 ? rest : rest.slice(0, next)
}

test('e2e job runs full suite on PR/push with hard timeout and sanitized artifacts', () => {
  const block = jobBlock('e2e')
  assert.match(block, /timeout-minutes:\s*\d+/)
  assert.ok(block.includes('pnpm run test:e2e'), 'e2e job must run pnpm test:e2e')
  // 上传产物必须先过脱敏脚本
  const scrubAt = block.indexOf('scrub-e2e-artifacts.ts')
  const uploadAt = block.indexOf('actions/upload-artifact')
  assert.ok(scrubAt > 0, 'e2e must scrub artifacts before upload')
  assert.ok(uploadAt > scrubAt, 'upload-artifact must come after scrub step')
  assert.match(block, /if:\s*failure\(\)/)
  assert.match(block, /retention-days:\s*\d+/)
})

test('merge-gate aggregates lint/test/build/smoke/e2e and fails on non-success', () => {
  const block = jobBlock('gate')
  assert.match(block, /name:\s*merge-gate/)
  for (const dep of ['lint-typecheck', 'test', 'build', 'smoke', 'e2e']) {
    assert.ok(block.includes(dep), `merge-gate needs ${dep}`)
  }
  assert.match(block, /if:\s*always\(\)/)
  assert.match(block, /result\s*!=\s*"success"/)
  // ssh-e2e 不进门禁（可选信号，fork 无 secrets 不能阻塞合并）
  const needs = block.match(/needs:\s*\[([^\]]+)\]/)
  assert.ok(needs)
  assert.ok(!needs![1].includes('ssh-e2e'), 'ssh-e2e must not be a required gate dependency')
})

test('ssh-e2e job skips cleanly without secrets and never touches real :3001', () => {
  const block = jobBlock('ssh-e2e')
  // fork PR 不跑（head repo 不同源直接跳过整个 job）
  assert.match(block, /if:.*pull_request\.head\.repo\.full_name\s*==\s*github\.repository/)
  // 同仓但未配 secrets：step 级检查给 notice 并 skip，不报错
  assert.match(block, /skip=1/)
  assert.match(block, /::notice::SSH e2e skipped/)
  assert.match(block, /pnpm run test:ssh-e2e/)
})

test('workflow has no plaintext secrets and e2e/smoke run isolated', () => {
  // 只允许 secrets.* 上下文引用，禁止明文 token/password/key
  const plaintext = ci.match(/(token|password|private.?key)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{12,}/gi)
  assert.deepEqual(plaintext || [], [], `plaintext secret-like values found: ${plaintext}`)
  // e2e/smoke 不经环境变量指向真实生产端口
  assert.ok(!/127\.0\.0\.1:3001/.test(ci), 'ci.yml must not target production :3001')
})
