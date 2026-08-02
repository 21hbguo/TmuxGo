import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebSocket } from 'ws'
import { agentManager } from './agent-manager.js'

test('keeps a replacement agent connected when the previous socket closes', () => {
  const id = `agent-${Date.now()}-${Math.random()}`
  const first = {} as WebSocket
  const second = {} as WebSocket
  agentManager.register(id, 'agent', '127.0.0.1', '1.0.0', first)
  agentManager.register(id, 'agent', '127.0.0.1', '1.1.0', second)
  assert.equal(agentManager.unregister(id, first), false)
  assert.equal(agentManager.heartbeat(id, second, '1.1.1'), true)
  const active = agentManager.getAgent(id)
  assert.equal(active?.online, true)
  assert.equal(active?.version, '1.1.1')
  assert.equal(active?.reconnectCount, 1)
  assert.equal(agentManager.unregister(id, second), true)
  const disconnected = agentManager.getAgentStatus(id)
  assert.equal(disconnected?.online, false)
  assert.equal(disconnected?.disconnectReason, 'Disconnected')
})
