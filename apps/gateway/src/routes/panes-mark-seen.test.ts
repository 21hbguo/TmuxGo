import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { forgetAgentPane, _setAgentPaneRecordForTest } from '../lib/agent-state.js'
import type { AgentPaneState } from '../lib/agent-state.js'
import { paneRoutes } from './panes.js'

function record(paneId: string, agentStatus: AgentPaneState['agentStatus']): AgentPaneState {
  return {
    paneId,
    tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1),
    sessionName: 'dev',
    agent: 'codex',
    agentSessionId: paneId + ':dev',
    agentStatus,
    phase: agentStatus === 'blocked' ? 'permission_required' : agentStatus === 'working' ? 'working' : 'idle',
    lastEvent: agentStatus === 'done' ? 'completed' : 'started',
    source: 'process',
    confidence: 'medium',
    since: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:01.000Z',
    eventId: `${paneId}:${agentStatus}`,
    revision: 1,
  }
}

// done→idle 单标记 + 幂等（重复调用不再计入 marked，状态不回退）
test('marks a done pane as seen exactly once', async () => {
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  _setAgentPaneRecordForTest(record('local:%9', 'done'))
  try {
    const first = await fastify.inject({ method: 'POST', url: '/panes/mark-seen', payload: { paneId: 'local:%9' } })
    assert.equal(first.statusCode, 200)
    assert.deepEqual(first.json(), { ok: true, marked: 1 })
    const second = await fastify.inject({ method: 'POST', url: '/panes/mark-seen', payload: { paneId: 'local:%9' } })
    assert.deepEqual(second.json(), { ok: true, marked: 0 })
  } finally {
    await fastify.close()
    forgetAgentPane('local:%9')
  }
})

// 批量 + 去重：重复 paneId 只计一次；未知 pane 不报错、不计入
test('batch mark-seen dedupes ids and tolerates unknown panes', async () => {
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  _setAgentPaneRecordForTest(record('local:%10', 'done'))
  _setAgentPaneRecordForTest(record('local:%11', 'done'))
  try {
    const response = await fastify.inject({
      method: 'POST',
      url: '/panes/mark-seen',
      payload: { paneIds: ['local:%10', 'local:%10', 'local:%11', 'local:%404'] },
    })
    assert.deepEqual(response.json(), { ok: true, marked: 2 })
  } finally {
    await fastify.close()
    forgetAgentPane('local:%10')
    forgetAgentPane('local:%11')
  }
})

// working/blocked 不可被误清：状态不动、不计入 marked
test('does not touch working or blocked panes', async () => {
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  _setAgentPaneRecordForTest(record('local:%12', 'working'))
  _setAgentPaneRecordForTest(record('local:%13', 'blocked'))
  try {
    const response = await fastify.inject({
      method: 'POST',
      url: '/panes/mark-seen',
      payload: { paneIds: ['local:%12', 'local:%13'] },
    })
    assert.deepEqual(response.json(), { ok: true, marked: 0 })
  } finally {
    await fastify.close()
    forgetAgentPane('local:%12')
    forgetAgentPane('local:%13')
  }
})

// 参数校验：paneId/paneIds 至少给其一；非法 paneId 整体拒绝
test('rejects empty payload and malformed pane ids', async () => {
  const fastify = Fastify()
  await fastify.register(paneRoutes)
  try {
    const empty = await fastify.inject({ method: 'POST', url: '/panes/mark-seen', payload: {} })
    assert.equal(empty.statusCode, 500) // 未接 index.ts 的 ZodError→400 handler 时默认 500，语义即拒绝
    const bad = await fastify.inject({
      method: 'POST',
      url: '/panes/mark-seen',
      payload: { paneIds: ['local:%9', 'garbage'] },
    })
    assert.equal(bad.statusCode, 500)
  } finally {
    await fastify.close()
  }
})
