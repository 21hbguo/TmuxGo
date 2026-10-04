import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { upsertRecoveryCandidate } from '../lib/agent-recovery.js'
import { agentRecoveryRoutes } from './agent-recovery.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
const hostId = 'local'
process.env.TMUXGO_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-route-'))
// manifest 按 TMUXGO_CONFIG_DIR 懒解析：每个用例切独立目录，互不串候选
function freshConfigDir() {
  process.env.TMUXGO_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-route-'))
}
async function firstPaneId() {
  const { stdout } = await execTmuxFile('tmux', ['list-panes', '-s', '-t', TEST_TMUX_SESSION, '-F', '#{pane_id}'])
  return stdout.trim().split('\n')[0]
}
// new-session 的 pane 进程异步就绪：send-keys/occupant 判定前先等目标命令出现
async function waitForPane(paneId: string, ready: (command: string) => boolean) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { stdout } = await execTmuxFile('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_command}'])
    if (ready(stdout.trim())) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const shellReady = (command: string) => !!command && command !== 'tmux'
async function capturePane(paneId: string) {
  const { stdout } = await execTmuxFile('tmux', ['capture-pane', '-p', '-t', paneId])
  return stdout
}
function seed(overrides: Partial<Parameters<typeof upsertRecoveryCandidate>[0]> = {}) {
  return upsertRecoveryCandidate({
    hostId,
    sessionName: TEST_TMUX_SESSION,
    paneId: `${hostId}:%1`,
    tmuxPaneId: '%1',
    agent: 'claude',
    agentSessionId: 'claude-session-abc123',
    reason: 'pane_exited',
    ...overrides,
  })!
}
test('lists recovery candidates with live occupant inspection', async () => {
  const fastify = Fastify()
  await fastify.register(agentRecoveryRoutes)
  try {
    freshConfigDir()
    await execTmuxFile('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', TEST_TMUX_SESSION])
    const paneId = await firstPaneId()
    await waitForPane(paneId, shellReady)
    const saved = seed({ paneId: `${hostId}:${paneId}`, tmuxPaneId: paneId })
    const response = await fastify.inject({ method: 'GET', url: `/hosts/${hostId}/agent-recovery` })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.version, 1)
    const item = body.candidates.find((entry: any) => entry.id === saved.id)
    assert.ok(item)
    assert.equal(item.resumable, true)
    assert.equal(item.occupant, 'shell')
    // 候选必须可序列化且无多余敏感字段（blockReason 仅受阻时存在）
    assert.deepEqual(Object.keys(item).sort(), [
      'agent',
      'agentSessionId',
      'createdAt',
      'hostId',
      'id',
      'lastSeenAt',
      'occupant',
      'paneId',
      'reason',
      'resumable',
      'sessionName',
      'status',
      'tmuxPaneId',
    ])
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('resume types the provider command into an idle shell pane', async () => {
  const fastify = Fastify()
  await fastify.register(agentRecoveryRoutes)
  try {
    freshConfigDir()
    await execTmuxFile('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', TEST_TMUX_SESSION])
    const paneId = await firstPaneId()
    await waitForPane(paneId, shellReady)
    const saved = seed({ paneId: `${hostId}:${paneId}`, tmuxPaneId: paneId })
    const response = await fastify.inject({
      method: 'POST',
      url: `/hosts/${hostId}/agent-recovery/${saved.id}/resume`,
      payload: { paneId: saved.paneId, agentSessionId: saved.agentSessionId },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.command, `claude --resume ${saved.agentSessionId}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.match(await capturePane(paneId), /claude --resume claude-session-abc123/)
    const listed = (await fastify.inject({ method: 'GET', url: `/hosts/${hostId}/agent-recovery` })).json()
    assert.equal(listed.candidates.length, 0)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('resume rejects unknown provider, missing session id and mismatched target', async () => {
  const fastify = Fastify()
  await fastify.register(agentRecoveryRoutes)
  try {
    freshConfigDir()
    await execTmuxFile('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', TEST_TMUX_SESSION])
    const paneId = await firstPaneId()
    const unknown = seed({
      paneId: `${hostId}:${paneId}`,
      tmuxPaneId: paneId,
      agent: 'gemini',
      agentSessionId: 'gem-1',
    })
    const noId = seed({ paneId: `${hostId}:%98`, tmuxPaneId: '%98', agentSessionId: undefined })
    const valid = seed({ paneId: `${hostId}:%99`, tmuxPaneId: '%99', agent: 'codex', agentSessionId: 't-9' })
    const post = (id: string, payload: { paneId: string; agentSessionId: string }) =>
      fastify.inject({ method: 'POST', url: `/hosts/${hostId}/agent-recovery/${id}/resume`, payload })
    const provider = await post(unknown.id, { paneId: unknown.paneId, agentSessionId: 'gem-1' })
    assert.equal(provider.statusCode, 400)
    assert.equal(provider.json().code, 'provider_not_supported')
    const missing = await post(noId.id, { paneId: noId.paneId, agentSessionId: 'x' })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().code, 'missing_session_id')
    const mismatch = await post(valid.id, { paneId: valid.paneId, agentSessionId: 'different' })
    assert.equal(mismatch.statusCode, 400)
    assert.equal(mismatch.json().code, 'target_mismatch')
    // 校验失败的候选仍保持 pending、未执行任何恢复动作
    assert.equal((await post('missing-id', { paneId: 'x', agentSessionId: 'y' })).statusCode, 404)
    const listed = (await fastify.inject({ method: 'GET', url: `/hosts/${hostId}/agent-recovery` })).json()
    assert.equal(listed.candidates.length, 3)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
test('resume refuses an occupied or missing pane and never runs on its own', async () => {
  const fastify = Fastify()
  await fastify.register(agentRecoveryRoutes)
  try {
    freshConfigDir()
    // 占位进程把 pane 变成 occupied——恢复不得覆盖其他 occupant
    await execTmuxFile('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', TEST_TMUX_SESSION, 'sleep 300'])
    const paneId = await firstPaneId()
    await waitForPane(paneId, (command) => command === 'sleep')
    const occupied = seed({ paneId: `${hostId}:${paneId}`, tmuxPaneId: paneId })
    const gone = seed({ paneId: `${hostId}:%95`, tmuxPaneId: '%95', agentSessionId: 'gone-1' })
    const post = (id: string, payload: { paneId: string; agentSessionId: string }) =>
      fastify.inject({ method: 'POST', url: `/hosts/${hostId}/agent-recovery/${id}/resume`, payload })
    const busy = await post(occupied.id, { paneId: occupied.paneId, agentSessionId: occupied.agentSessionId! })
    assert.equal(busy.statusCode, 409)
    assert.equal(busy.json().code, 'pane_occupied')
    const missing = await post(gone.id, { paneId: gone.paneId, agentSessionId: gone.agentSessionId! })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().code, 'pane_missing')
    // 未被确认的候选保持 pending：无任何隐式恢复路径
    const listed = (await fastify.inject({ method: 'GET', url: `/hosts/${hostId}/agent-recovery` })).json()
    assert.equal(listed.candidates.filter((entry: any) => entry.status === 'pending').length, 2)
    assert.equal(listed.candidates.find((entry: any) => entry.id === occupied.id).blockReason, 'pane_occupied')
    assert.equal(listed.candidates.find((entry: any) => entry.id === gone.id).blockReason, 'pane_missing')
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})
