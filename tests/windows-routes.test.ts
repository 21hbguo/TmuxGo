import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../apps/gateway/src/test-tmux'
import { windowRoutes } from '../apps/gateway/src/routes/windows'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
test('window routes return the created window and active pane from the active window', async () => {
  const sessionName = TEST_TMUX_SESSION
  const fastify = Fastify()
  await windowRoutes(fastify)
  try {
    await execTmuxFile('tmux', ['new-session', '-d', '-s', sessionName])
    const { stdout } = await execTmuxFile('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
    const firstIndex = Number(stdout.trim())
    await execTmuxFile('tmux', ['new-window', '-d', '-t', `${sessionName}:${firstIndex + 2}`, '-n', 'old-last'])
    const sessionId = `session-local-${sessionName}`
    const createResponse = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${sessionId}/windows`,
      payload: { name: 'created' },
    })
    assert.equal(createResponse.statusCode, 200)
    const created = createResponse.json()
    assert.equal(created.name, 'created')
    assert.equal(created.index, firstIndex + 1)
    assert.equal(created.active, true)
    const snapshotResponse = await fastify.inject({ method: 'GET', url: `/hosts/local/sessions/${sessionId}/snapshot` })
    assert.equal(snapshotResponse.statusCode, 200)
    const snapshot = snapshotResponse.json()
    const activePane = snapshot.panes.find((pane: any) => pane.id === snapshot.activePaneId)
    assert.equal(activePane.windowId, snapshot.activeWindowId)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
