import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { VIEW_BASE_OPTION, VIEW_CLIENT_OPTION, viewSessionName } from '../lib/view-sessions.js'
import { sessionRoutes } from './sessions.js'

// grouped view session 必须从所有用户可见的会话枚举里消失；但同名前缀的普通
// session 是用户自己建的，绝不能按名字隐藏。
test('session list hides grouped views but keeps same-prefix user sessions', async () => {
  const fastify = Fastify()
  await fastify.register(sessionRoutes)
  const decoyName = 'tmuxgo-view-user-owned'
  const viewId = 'listview0001'
  const viewName = viewSessionName('local', TEST_TMUX_SESSION, viewId)
  const kill = (name: string) => execTmuxFile('tmux', ['kill-session', '-t', `=${name}`]).catch(() => {})
  try {
    await killTestTmuxSession()
    await kill(viewName)
    await kill(decoyName)
    await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION])
    await execTmuxFile('tmux', ['new-session', '-d', '-s', decoyName])
    // 真正的 view：grouped session + 归属 option
    await execTmuxFile('tmux', ['new-session', '-d', '-t', TEST_TMUX_SESSION, '-s', viewName])
    await execTmuxFile('tmux', ['set-option', '-t', viewName, VIEW_BASE_OPTION, TEST_TMUX_SESSION])
    await execTmuxFile('tmux', ['set-option', '-t', viewName, VIEW_CLIENT_OPTION, viewId])

    // 先证明 tmux 原始列表里三者都在，失败时能区分「没造出来」与「没过滤掉」
    const { stdout: raw } = await execTmuxFile('tmux', ['list-sessions', '-F', '#{session_name}\t#{@tmuxgo_view_base}'])
    assert.match(raw, new RegExp(`${viewName}\\t${TEST_TMUX_SESSION}`))
    assert.match(raw, new RegExp(`${decoyName}\\t$`, 'm'))

    const response = await fastify.inject({ method: 'GET', url: '/hosts/local/sessions?agents=0' })
    assert.equal(response.statusCode, 200, response.body)
    const sessions = response.json() as { name: string }[]
    const names = sessions.map((session) => session.name)
    assert.equal(names.includes(viewName), false)
    assert.equal(names.includes(TEST_TMUX_SESSION), true)
    assert.equal(names.includes(decoyName), true)
    // 不锁绝对条数：同一 tmux server 上可能还有其它用例留下的用户 session；
    // 只要求本次三个目标里，base/decoy 在、view 不在。
    assert.deepEqual(
      names.filter((name) => name === TEST_TMUX_SESSION || name === decoyName).sort(),
      [TEST_TMUX_SESSION, decoyName].sort(),
    )
  } finally {
    await fastify.close()
    await kill(viewName)
    await kill(decoyName)
    await killTestTmuxSession()
  }
})
