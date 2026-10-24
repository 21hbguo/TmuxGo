import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPullFailure, parsePullFailureState } from './git-pull-classify.js'

// porcelain v2 输出按 git 原样拼（头部行 + 记录行），不依赖 locale
const statusV2 = (headers: string[], records: string[] = []) => [...headers, ...records].join('\n')

test('parses upstream, divergence, detached and dirty markers', () => {
  const state = parsePullFailureState(
    statusV2(
      ['# branch.oid 1234567', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'],
      ['1 .M N... 100644 100644 100644 abc def a.txt'],
    ),
  )
  assert.deepEqual(state, {
    unmerged: false,
    ahead: 2,
    behind: 3,
    upstream: 'origin/main',
    detached: false,
    dirty: true,
  })
})

test('marks unmerged paths from u records', () => {
  const state = parsePullFailureState(
    statusV2(
      ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -1'],
      ['u UU N... 100644 100644 100644 100644 aaa bbb ccc base.txt'],
    ),
  )
  assert.equal(state.unmerged, true)
  assert.equal(state.dirty, true)
})

test('detects detached HEAD and missing upstream', () => {
  const detached = parsePullFailureState(statusV2(['# branch.head (detached)', '# branch.oid 1234567']))
  assert.equal(detached.detached, true)
  assert.equal(detached.upstream, null)

  const tracked = parsePullFailureState(statusV2(['# branch.head main', '# branch.upstream origin/main']))
  assert.equal(tracked.detached, false)
  assert.equal(tracked.upstream, 'origin/main')
})

test('conflicts win over everything (pull conflict may also leave MERGE_HEAD)', () => {
  const state = parsePullFailureState(
    statusV2(
      ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +1 -1'],
      ['u UU N... 100644 100644 100644 100644 aaa bbb ccc a.txt'],
    ),
  )
  assert.deepEqual(classifyPullFailure(state, { rebase: false, merge: true }), { kind: 'conflicts' })
})

test('in-progress rebase/merge outranks divergence so the strategy dialog does not misfire', () => {
  // 真机复现：合并冲突解决但没提交时 branch.ab 是 +1 -1，按分叉弹窗会让用户选了也照样失败
  const divergedLooking = parsePullFailureState(
    statusV2(['# branch.head main', '# branch.upstream origin/main', '# branch.ab +1 -1']),
  )
  assert.deepEqual(classifyPullFailure(divergedLooking, { rebase: false, merge: true }), { kind: 'merge-in-progress' })
  assert.deepEqual(classifyPullFailure(divergedLooking, { rebase: true, merge: false }), { kind: 'rebase-in-progress' })
  assert.deepEqual(classifyPullFailure(divergedLooking, { rebase: false, merge: false }), {
    kind: 'diverged',
    ahead: 1,
    behind: 1,
  })
})

test('rebase in progress is reported even though HEAD is detached', () => {
  const state = parsePullFailureState(statusV2(['# branch.head (detached)', '# branch.oid 1234567']))
  assert.deepEqual(classifyPullFailure(state, { rebase: true, merge: false }), { kind: 'rebase-in-progress' })
  assert.deepEqual(classifyPullFailure(state, { rebase: false, merge: false }), { kind: 'detached-head' })
})

test('no upstream and dirty-tree states', () => {
  const noUpstream = parsePullFailureState(statusV2(['# branch.head feature', '# branch.oid 1234567']))
  assert.deepEqual(classifyPullFailure(noUpstream, { rebase: false, merge: false }), { kind: 'no-upstream' })

  const dirtyBehind = parsePullFailureState(
    statusV2(['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -2'], ['? notes.txt']),
  )
  assert.deepEqual(classifyPullFailure(dirtyBehind, { rebase: false, merge: false }), { kind: 'dirty-tree' })
})

test('dirty tree without incoming commits is not classified (keeps genuine failures as 500)', () => {
  const dirtyNoIncoming = parsePullFailureState(
    statusV2(
      ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'],
      ['1 .M N... 100644 100644 100644 abc def a.txt'],
    ),
  )
  assert.equal(classifyPullFailure(dirtyNoIncoming, { rebase: false, merge: false }), null)
})

test('explicit remote/branch makes a missing upstream harmless', () => {
  const noUpstream = parsePullFailureState(statusV2(['# branch.head main', '# branch.oid 1234567']))
  assert.equal(classifyPullFailure(noUpstream, { rebase: false, merge: false }, { explicitTarget: true }), null)
})

test('clean tracked branch with nothing outstanding stays unknown', () => {
  const clean = parsePullFailureState(
    statusV2(['# branch.head main', '# branch.upstream origin/main', '# branch.ab +1 -0']),
  )
  assert.equal(classifyPullFailure(clean, { rebase: false, merge: false }), null)
})
