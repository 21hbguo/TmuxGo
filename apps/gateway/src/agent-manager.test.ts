import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebSocket } from 'ws'
import { AgentManager, agentManager } from './agent-manager.js'

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

test('routes tmux commands to the matching Agent socket', async () => {
  const manager = new AgentManager()
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  const result = manager.executeTmux(id, ['list-sessions'])
  const request = JSON.parse(messages[0])
  assert.equal(request.type, 'tmux')
  assert.deepEqual(request.args, ['list-sessions'])
  assert.equal(manager.handleMessage(id, { readyState: 1 } as WebSocket, { type: 'tmux-result', requestId: request.requestId, stdout: 'other\n', stderr: '' }), false)
  assert.equal(manager.handleMessage(id, socket, { type: 'tmux-result', requestId: request.requestId, stdout: 'dev\n', stderr: '' }), true)
  assert.deepEqual(await result, { stdout: 'dev\n', stderr: '' })
  assert.equal(manager.unregister(id, socket), true)
})
