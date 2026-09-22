// CI 增量检查的 git diff 基准解析：按触发来源分别决定变更集合。
// 输出约定：stdout 最后一行是可直接喂 `git diff` 的 range/ref；reason 走 stderr，
// 保证手动触发等无基准场景不会静默等价「零文件通过」。
//   pull_request      → origin/<base_ref>...HEAD（三点，PR 引入的提交）
//   push              → <event.before>..HEAD（两点，本次推送区间）
//   push 无有效基准   → HEAD~1..HEAD（before 全零/缺失/不可解析，如分支首推）
//   workflow_dispatch → HEAD~1..HEAD（无 before 字段，取最近一次提交）
//   HEAD 无父提交     → <empty-tree>..HEAD（root commit，全量即首提交内容）
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const SHA_RE = /^[0-9a-f]{40}$/i
const ZERO_SHA_RE = /^0{40}$/

export interface ChangedRangeInput {
  event: string
  baseRef?: string
  before?: string
  refExists: (ref: string) => boolean
}
export interface ChangedRangeResult {
  range: string
  reason: string
}

function headFallback(reason: string, refExists: (ref: string) => boolean): ChangedRangeResult {
  if (refExists('HEAD~1')) return { range: 'HEAD~1..HEAD', reason: `${reason}; baseline = last commit` }
  return {
    range: `${EMPTY_TREE}..HEAD`,
    reason: `${reason}; HEAD has no parent, baseline = empty tree (root commit = whole tree)`,
  }
}

export function resolveChangedRange({ event, baseRef, before, refExists }: ChangedRangeInput): ChangedRangeResult {
  if (event === 'pull_request' || event === 'pull_request_target') {
    const base = (baseRef || '').trim()
    if (base) {
      const ref = `origin/${base}`
      if (refExists(ref)) return { range: `${ref}...HEAD`, reason: `${event}: three-dot diff against ${ref}` }
      return headFallback(`${event}: base ref ${ref} not resolvable`, refExists)
    }
    return headFallback(`${event}: base_ref missing`, refExists)
  }
  if (event === 'push') {
    const sha = (before || '').trim()
    if (SHA_RE.test(sha) && !ZERO_SHA_RE.test(sha)) {
      if (refExists(sha)) return { range: `${sha}..HEAD`, reason: `push: diff against event.before ${sha}` }
      return headFallback(`push: event.before ${sha} not present in repository`, refExists)
    }
    const why = ZERO_SHA_RE.test(sha)
      ? 'event.before is all zeros (new branch / first push)'
      : sha
        ? `event.before '${sha}' is not a full SHA`
        : 'event.before missing'
    return headFallback(`push: ${why}`, refExists)
  }
  return headFallback(`${event || 'unknown'}: no push/PR baseline (manual or scheduled trigger)`, refExists)
}

function refExistsLocal(ref: string) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function main() {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const result = resolveChangedRange({
    event: option('--event') || '',
    baseRef: option('--base-ref'),
    before: option('--before'),
    refExists: refExistsLocal,
  })
  console.error(`ci-changed-range: ${result.reason}`)
  console.log(result.range)
}

const invokedPath = process.argv[1] ? resolve(realpathSync(process.argv[1])) : ''
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main()
