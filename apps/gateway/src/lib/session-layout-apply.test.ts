import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionCreateArgs } from './session-layout-apply.js'

// window0/pane0 由 new-session 创建：它的 cwd 只能在建 session 时用 -c 传，
// 漏了就会继承 tmux server 的 cwd（远端新起 server = home），恢复出来的首 pane 落错目录
test('passes the first pane cwd to new-session -c', () => {
  const args = buildSessionCreateArgs('work', { windows: [{ name: 'editor', panes: [{ cwd: '/repo/app' }] }] })
  assert.deepEqual(args, ['new-session', '-d', '-s', 'work', '-e', 'TMUXGO_ENV=1', '-c', '/repo/app'])
})

test('omits -c when the first pane has no cwd so the server cwd is inherited as before', () => {
  const base = ['new-session', '-d', '-s', 'work', '-e', 'TMUXGO_ENV=1']
  assert.deepEqual(buildSessionCreateArgs('work', { windows: [{ name: 'w', panes: [{}] }] }), base)
  assert.deepEqual(buildSessionCreateArgs('work', { windows: [{ name: 'w', panes: [{ cwd: '   ' }] }] }), base)
  assert.deepEqual(buildSessionCreateArgs('work', { windows: [] }), base)
})

test('only the first window first pane decides the session cwd', () => {
  const args = buildSessionCreateArgs('work', {
    windows: [
      { name: 'editor', panes: [{}] },
      { name: 'logs', panes: [{ cwd: '/var/log' }] },
    ],
  })
  // 后续 window 的 cwd 由 new-window -c 负责，不能顶替首 pane 的
  assert.equal(args.includes('-c'), false)
})
