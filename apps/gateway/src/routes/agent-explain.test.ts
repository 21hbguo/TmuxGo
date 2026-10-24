import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { paneRoutes } from './panes.js'

// 真实 tmux：只动隔离 server 上的 test session
test('explains a live pane and rejects bad or unknown ids', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    // 假 agent 屏：claude 有「被打码的 chrome 词面」但**没有** manifest，
    // 正好覆盖 fallback 分支（manifest=null、reason 写明通用词面）
    await execTmuxFile('tmux', [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-x',
      '120',
      '-y',
      '40',
      'bash',
      '-lc',
      `printf 'Claude Code v1.2.3\\nAllow command?\\n[y/n]\\n'; sleep 30`,
    ])
    const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    const tmuxPaneId = stdout.trim().split('\n')[0]
    const ok = await fastify.inject({
      method: 'GET',
      url: `/hosts/local/panes/agent-explain?paneId=${encodeURIComponent(`local:${tmuxPaneId}`)}`,
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.headers['cache-control'], 'no-store')
    const body = ok.json()
    assert.equal(body.ok, true)
    assert.equal(body.paneId, `local:${tmuxPaneId}`)
    assert.equal(body.sessionName, sessionName)
    assert.equal(body.agent.name, 'claude')
    // pane 前台是 bash，agent 只能从屏幕 chrome 词面认出来（source=screen）
    assert.equal(body.agent.source, 'screen')
    assert.equal(body.agent.evidence, 'claude chrome text')
    assert.equal(body.state.agentStatus, 'blocked')
    assert.equal(body.screen.manifest, null)
    assert.equal(body.screen.rule, null)
    assert.match(body.screen.miss, /no detection manifest for agent "claude"/)
    assert.equal(body.fallback.used, true)
    assert.equal(body.fallback.reason, body.screen.miss)
    assert.equal(body.process.scanned, true)
    // 输出不得回显屏幕内容（只有标签与元数据）
    assert.equal(JSON.stringify(body).includes('Allow command?'), false)

    const badId = await fastify.inject({ method: 'GET', url: '/hosts/local/panes/agent-explain?paneId=not-a-pane' })
    assert.equal(badId.statusCode, 400)
    assert.equal(badId.json().code, 'INVALID_PANE_ID')

    const missing = await fastify.inject({
      method: 'GET',
      url: `/hosts/local/panes/agent-explain?paneId=${encodeURIComponent('local:%999999')}`,
    })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().code, 'PANE_MISSING')
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
