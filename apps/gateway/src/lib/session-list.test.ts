import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isEmptyTmuxServerError,
  parseUserSessionNames,
  parseUserSessions,
  parseViewSessionNames,
} from './session-list.js'

// 解析层单测：不碰 tmux，专测「按 tab 而不是空格/竖线切」与「只认 option 不认前缀」
test('parseUserSessions drops view-backed rows and keeps same-prefix user sessions', () => {
  const stdout = [
    '@0\ttest\t2\t1700000000\t1700000001\t1\t',
    '@1\ttmuxgo-view-user-owned\t1\t1700000000\t1700000001\t0\t',
    '@2\ttmuxgo-view-deadbeef\t3\t1700000000\t1700000001\t0\ttest',
    '@3\twork\t1\t1700000000\t1700000001\t0\tbase with space',
  ].join('\n')
  const sessions = parseUserSessions('local', stdout)
  assert.deepEqual(
    sessions.map((session) => session.name),
    ['test', 'tmuxgo-view-user-owned'],
  )
  // 结构保持旧 getHostTmuxSessions 的字段与类型
  assert.deepEqual(sessions[0], {
    id: 'session-local-test',
    hostId: 'local',
    name: 'test',
    createdAt: new Date(1700000000 * 1000).toISOString(),
    lastActiveAt: new Date(1700000001 * 1000).toISOString(),
    windowCount: 2,
    attached: true,
  })
})

test('parseUserSessions skips names outside the gateway naming contract instead of failing the list', () => {
  // tmux 本身允许空格名，但网关命名契约不接受；旧实现经 assertSessionAllowed
  // 逐行过滤，这里同样跳过该行而不是让整张列表抛错。
  const sessions = parseUserSessions('local', '@9\twork space\t1\t1700000000\t1700000000\t0\t')
  assert.deepEqual(sessions, [])
})

test('parseViewSessionNames selects only rows whose view base option is non-empty', () => {
  const names = parseViewSessionNames(
    ['test\t', 'tmuxgo-view-user-owned\t', 'tmuxgo-view-abc\ttest', 'base with space\tother base'].join('\n'),
  )
  assert.deepEqual([...names], ['tmuxgo-view-abc', 'base with space'])
})

test('parseUserSessionNames keeps base and drops view rows (snapshot restore existence check)', () => {
  const names = parseUserSessionNames(
    ['work\t', 'test\tsome-base', 'tmuxgo-view-user-owned\t', 'tmuxgo-view-abc\ttest'].join('\n'),
  )
  // 恢复快照判断「已存在」只能用用户会话名；view 名当成已存在会覆盖 base
  assert.deepEqual(names, ['work', 'tmuxgo-view-user-owned'])
})

// 「没有 server / 没有 session」是空列表，不是故障：变更订阅的探针靠这条判定
// 决定「记一次空签名」还是「进失败退避」，判定错会让 server 冷启动晚十几秒才被发现
test('isEmptyTmuxServerError recognises empty-server errors and nothing else', () => {
  assert.equal(isEmptyTmuxServerError(new Error('no server running on /tmp/tmux-501/default')), true)
  assert.equal(isEmptyTmuxServerError(new Error('failed to connect to server')), true)
  assert.equal(isEmptyTmuxServerError(new Error('no sessions')), true)
  // server 刚 exit-empty 时 socket 已被删：路径不固定，只能按错误语义判
  assert.equal(
    isEmptyTmuxServerError(new Error('error connecting to /tmp/tmux-1000/default (No such file or directory)')),
    true,
  )
  assert.equal(isEmptyTmuxServerError(new Error('Permission denied (publickey)')), false)
  assert.equal(isEmptyTmuxServerError(new Error('Connection timed out')), false)
  assert.equal(isEmptyTmuxServerError('no sessions'), true)
  assert.equal(isEmptyTmuxServerError(null), false)
})
