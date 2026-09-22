import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_TREE, resolveChangedRange } from '../scripts/ci-changed-range'

const SHA = 'a'.repeat(40)
const ZERO = '0'.repeat(40)
const all = () => true
const only =
  (...refs: string[]) =>
  (ref: string) =>
    refs.includes(ref)

test('pull_request resolves a three-dot range against origin/<base_ref>', () => {
  const result = resolveChangedRange({ event: 'pull_request', baseRef: 'master', refExists: all })
  assert.equal(result.range, 'origin/master...HEAD')
  assert.match(result.reason, /pull_request/)
})

test('pull_request falls back when origin/<base_ref> is missing', () => {
  const result = resolveChangedRange({ event: 'pull_request', baseRef: 'master', refExists: only('HEAD~1') })
  assert.equal(result.range, 'HEAD~1..HEAD')
  assert.match(result.reason, /not resolvable/)
})

test('push resolves <before>..HEAD when before is a real commit', () => {
  const result = resolveChangedRange({ event: 'push', before: SHA, refExists: all })
  assert.equal(result.range, `${SHA}..HEAD`)
})

test('push with all-zero before uses last commit as baseline', () => {
  const result = resolveChangedRange({ event: 'push', before: ZERO, refExists: only('HEAD~1') })
  assert.equal(result.range, 'HEAD~1..HEAD')
  assert.match(result.reason, /all zeros/)
})

test('push with unresolvable before falls back to last commit', () => {
  const result = resolveChangedRange({ event: 'push', before: SHA, refExists: only('HEAD~1') })
  assert.equal(result.range, 'HEAD~1..HEAD')
  assert.match(result.reason, /not present/)
})

test('workflow_dispatch uses last commit and says so explicitly', () => {
  const result = resolveChangedRange({ event: 'workflow_dispatch', refExists: only('HEAD~1') })
  assert.equal(result.range, 'HEAD~1..HEAD')
  assert.match(result.reason, /workflow_dispatch.*manual/i)
})

test('manual trigger on a root commit diffs against the empty tree', () => {
  const result = resolveChangedRange({ event: 'workflow_dispatch', refExists: () => false })
  assert.equal(result.range, `${EMPTY_TREE}..HEAD`)
})
