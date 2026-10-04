import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import {
  assertSafeBranchName,
  assertSafeWorktreePath,
  buildWorktreeAddArgs,
  buildWorktreeRemoveArgs,
  classifyWorktreeRemoveByState,
  classifyWorktreeRemoveError,
  mergeWorktreeProvenance,
  parseWorktreeListPorcelain,
  readWorktreeRecords,
  removeWorktreeRecord,
  upsertWorktreeRecord,
} from './git-worktree.js'

test('parses worktree list --porcelain output', () => {
  const stdout = [
    'worktree /repo/main',
    'HEAD aaaaaaaa',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt-feature',
    'HEAD bbbbbbbb',
    'branch refs/heads/feature/x',
    '',
    'worktree /repo/wt-detached',
    'HEAD cccccccc',
    'detached',
    '',
    'worktree /repo/wt-locked',
    'HEAD dddddddd',
    'branch refs/heads/locked',
    'locked reason text',
    'prunable reason',
    '',
  ].join('\n')
  const worktrees = parseWorktreeListPorcelain(stdout)
  assert.equal(worktrees.length, 4)
  assert.deepEqual(worktrees[0], {
    path: '/repo/main',
    head: 'aaaaaaaa',
    branch: 'main',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  })
  assert.equal(worktrees[1].branch, 'feature/x')
  assert.equal(worktrees[2].detached, true)
  assert.equal(worktrees[3].locked, true)
  assert.equal(worktrees[3].prunable, true)
})

test('validates worktree paths against traversal and option injection', () => {
  assert.equal(assertSafeWorktreePath('/repo/wt'), '/repo/wt')
  assert.equal(assertSafeWorktreePath('/repo/wt/'), '/repo/wt')
  assert.throws(() => assertSafeWorktreePath('relative/wt'), /absolute/)
  assert.throws(() => assertSafeWorktreePath('/repo/../etc'), /\.\./)
  assert.throws(() => assertSafeWorktreePath('../wt'), /absolute/)
  assert.throws(() => assertSafeWorktreePath('/repo/wt\0x'), /Invalid/)
})

test('validates branch names against ref injection', () => {
  assert.equal(assertSafeBranchName('feature/x-y_z.1'), 'feature/x-y_z.1')
  assert.throws(() => assertSafeBranchName('-force'), /Invalid/)
  assert.throws(() => assertSafeBranchName('--upload-pack=x'), /Invalid/)
  assert.throws(() => assertSafeBranchName('feat ure'), /Invalid/)
  assert.throws(() => assertSafeBranchName('a..b'), /Invalid/)
  assert.throws(() => assertSafeBranchName('a@{b}'), /Invalid/)
  assert.throws(() => assertSafeBranchName('a.lock'), /Invalid/)
  assert.throws(() => assertSafeBranchName('a/'), /Invalid/)
  assert.throws(() => assertSafeBranchName(''), /Missing/)
})

test('builds worktree add args without shell interpolation', () => {
  assert.deepEqual(buildWorktreeAddArgs({ worktreePath: '/repo/wt' }), [
    'worktree',
    'add',
    '--detach',
    '--',
    '/repo/wt',
  ])
  assert.deepEqual(buildWorktreeAddArgs({ worktreePath: '/repo/wt', newBranch: 'feat' }), [
    'worktree',
    'add',
    '-b',
    'feat',
    '--',
    '/repo/wt',
  ])
  assert.deepEqual(buildWorktreeAddArgs({ worktreePath: '/repo/wt', branch: 'main' }), [
    'worktree',
    'add',
    '--',
    '/repo/wt',
    'main',
  ])
  assert.deepEqual(buildWorktreeAddArgs({ worktreePath: '/repo/wt', newBranch: 'feat', commit: 'abc123' }), [
    'worktree',
    'add',
    '-b',
    'feat',
    '--',
    '/repo/wt',
    'abc123',
  ])
  assert.throws(() => buildWorktreeAddArgs({ worktreePath: '/repo/wt', branch: '--force' }), /Invalid/)
})

test('builds worktree remove args and classifies failures', () => {
  assert.deepEqual(buildWorktreeRemoveArgs('/repo/wt', false), ['worktree', 'remove', '--', '/repo/wt'])
  assert.deepEqual(buildWorktreeRemoveArgs('/repo/wt', true), ['worktree', 'remove', '--force', '--', '/repo/wt'])
  assert.equal(
    classifyWorktreeRemoveError("fatal: '/repo/wt' contains modified or untracked files, use --force to delete it"),
    'dirty',
  )
  assert.equal(classifyWorktreeRemoveError("fatal: '/repo/wt' is not a working tree"), 'missing')
  assert.equal(classifyWorktreeRemoveError('ssh: connect to host x port 22: Connection refused'), 'other')
})

test('classifies remove failures by live state when messages are localized', async () => {
  const porcelain = 'worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /repo/wt\nHEAD b\ndetached\n\n'
  const exec = (statusOut: string | Error) => async (args: string[]) => {
    if (args[0] === 'worktree') return { stdout: porcelain }
    if (statusOut instanceof Error) throw statusOut
    return { stdout: statusOut }
  }
  assert.equal(await classifyWorktreeRemoveByState(exec('? dirty.txt\n'), '/repo', '/repo/wt'), 'dirty')
  assert.equal(await classifyWorktreeRemoveByState(exec(''), '/repo', '/repo/wt'), 'other')
  assert.equal(await classifyWorktreeRemoveByState(exec(''), '/repo', '/repo/absent'), 'missing')
  assert.equal(await classifyWorktreeRemoveByState(exec(new Error('gone')), '/repo', '/repo/wt'), 'other')
})

test('stores and dedupes worktree provenance records', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-wt-store-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  })
  const first = await upsertWorktreeRecord({
    hostId: 'local',
    repoPath: '/repo',
    worktreePath: '/repo/wt',
    branch: 'feat',
    commit: 'abc',
  })
  const second = await upsertWorktreeRecord({
    hostId: 'local',
    repoPath: '/repo',
    worktreePath: '/repo/wt',
    sessionId: 's1',
  })
  assert.equal(second.id, first.id)
  assert.equal(second.createdAt, first.createdAt)
  let records = await readWorktreeRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].sessionId, 's1')
  const merged = await mergeWorktreeProvenance('local', '/repo', [
    { path: '/repo', head: 'aaa', detached: false, bare: false, locked: false, prunable: false },
    { path: '/repo/wt', head: 'abc', detached: false, bare: false, locked: false, prunable: false },
  ])
  assert.equal(merged[0].provenance, undefined)
  assert.equal(merged[1].provenance?.sessionId, 's1')
  await removeWorktreeRecord('local', '/repo', '/repo/wt')
  records = await readWorktreeRecords()
  assert.equal(records.length, 0)
})
