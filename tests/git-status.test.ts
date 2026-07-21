import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGitRefs, parsePorcelainV2 } from '../apps/gateway/src/routes/git'

test('porcelain v2 parser preserves unicode paths and rename pairs', () => {
  const output = [
    '# branch.head main',
    '1 .M N... 100644 100644 100644 abc abc 中文 文件.txt',
    '2 R. N... 100644 100644 100644 abc abc R100 新 文件.txt',
    '旧 文件.txt',
    'u UU N... 100644 100644 100644 100644 abc abc abc 冲突 文件.txt',
    '? 未跟踪 文件.txt',
    '',
  ].join('\0')
  const status = parsePorcelainV2(output)
  assert.equal(status.branch, 'main')
  assert.deepEqual(status.unstaged, [{ path: '中文 文件.txt', status: 'modified', staged: false }])
  assert.deepEqual(status.staged, [{ path: '新 文件.txt', status: 'renamed', oldPath: '旧 文件.txt', staged: true }])
  assert.deepEqual(status.conflicted, [{ path: '冲突 文件.txt', status: 'unmerged', staged: false }])
  assert.deepEqual(status.untracked, ['未跟踪 文件.txt'])
})
test('git refs parser preserves remote branches and peeled tags', () => {
  const output = [
    'refs/remotes/origin/HEAD\ta1\t\trefs/remotes/origin/main',
    'refs/remotes/origin/main\ta1\t\t',
    'refs/tags/v1.0.0\ttag-object\tc1\t',
  ].join('\n')
  assert.deepEqual(parseGitRefs(output), [
    { name: 'origin/main', kind: 'remote', commitHash: 'a1' },
    { name: 'v1.0.0', kind: 'tag', commitHash: 'c1' },
  ])
})
