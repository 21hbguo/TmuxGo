import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'

// session 白名单在 tmux-policy 模块加载时读 env：必须先设再动态 import。
// 白名单设成 test session 自身，这样「本 session 通过 + 其它 session 被拒」能在同一个
// 进程里都测到（T-228 之后远端也走同一条断言，local 的覆盖等价）
process.env.TMUX_WEB_ALLOWED_SESSIONS = TEST_TMUX_SESSION
const { paneRoutes } = await import('./panes.js')

async function withPaneSession<T>(run: (paneId: string) => Promise<T>) {
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION])
    const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', TEST_TMUX_SESSION, '-F', '#{pane_id}'])
    return await run(`local:${stdout.trim().split('\n')[0]}`)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
}
const readTask = async (tmuxPaneId: string) => {
  try {
    const { stdout } = await execTmuxFile('tmux', ['show-options', '-p', '-t', tmuxPaneId, '@tmuxgo_task'])
    return stdout.trim()
  } catch {
    return ''
  }
}
test('writes the task into the pane user-option and clears it with -u', async () => {
  await withPaneSession(async (paneId) => {
    const tmuxPaneId = paneId.slice('local:'.length)
    const app = Fastify()
    await app.register(paneRoutes)
    try {
      const set = await app.inject({ method: 'POST', url: '/panes/task', payload: { paneId, task: 'T-234' } })
      assert.equal(set.statusCode, 200)
      const setBody = set.json() as { ok: boolean; task: string | null }
      assert.equal(setBody.ok, true)
      assert.equal(setBody.task, 'T-234')
      // 参数形状落到 tmux 实体上：pane option 就是 @tmuxgo_task
      assert.equal(await readTask(tmuxPaneId), '@tmuxgo_task T-234')

      // 首尾空白裁掉，不把空格写进去
      await app.inject({ method: 'POST', url: '/panes/task', payload: { paneId, task: '  T-235  ' } })
      assert.equal(await readTask(tmuxPaneId), '@tmuxgo_task T-235')

      // 空 task = 解绑：必须走 -u 删除，而不是写空串
      const cleared = await app.inject({ method: 'POST', url: '/panes/task', payload: { paneId, task: '' } })
      assert.equal(cleared.statusCode, 200)
      assert.equal((cleared.json() as { task: string | null }).task, null)
      assert.equal(await readTask(tmuxPaneId), '')
    } finally {
      await app.close()
    }
  })
})
test('rejects a target whose session is outside the allowlist', async () => {
  await withPaneSession(async (paneId) => {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', 'outside-list'])
    const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', 'outside-list', '-F', '#{pane_id}'])
    const outsidePane = `local:${stdout.trim().split('\n')[0]}`
    const app = Fastify()
    await app.register(paneRoutes)
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/panes/task',
        payload: { paneId: outsidePane, task: 'T-1' },
      })
      const body = response.json() as { ok: boolean; error?: string }
      assert.equal(body.ok, false)
      assert.match(body.error || '', /Session is not allowed/)
      // 被拒的写入不能落到目标 pane 上
      assert.equal(await readTask(outsidePane.slice('local:'.length)), '')
      // 名单内的 pane 仍然可写，证明拒绝来自策略而非路径本身坏了
      const allowed = await app.inject({ method: 'POST', url: '/panes/task', payload: { paneId, task: 'T-2' } })
      assert.equal((allowed.json() as { ok: boolean }).ok, true)
    } finally {
      await app.close()
      await execTmuxFile('tmux', ['kill-session', '-t', 'outside-list']).catch(() => {})
    }
  })
})
