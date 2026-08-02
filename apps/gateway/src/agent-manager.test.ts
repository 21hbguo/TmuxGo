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

test('forwards isolated terminal streams and closes them on Agent reconnect', async () => {
  const manager = new AgentManager()
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  const attachment = manager.attachTerminal(id, 'dev', 120, 36, true)
  const request = JSON.parse(messages[0])
  assert.equal(request.type, 'terminal-attach')
  assert.equal(manager.handleMessage(id, socket, { type: 'terminal-attached', requestId: request.requestId, attachmentId: '00000000-0000-4000-8000-000000000000', pid: 42 }), false)
  assert.equal(manager.handleMessage(id, socket, { type: 'terminal-attached', requestId: request.requestId, attachmentId: request.attachmentId, pid: 42 }), true)
  const terminal = await attachment
  let output = ''
  let exitCode: number | null = null
  terminal.onData((data) => { output += data })
  terminal.onExit((code) => { exitCode = code })
  assert.equal(manager.handleMessage(id, { readyState: 1 } as WebSocket, { type: 'terminal-output', attachmentId: terminal.id, data: 'wrong' }), false)
  assert.equal(manager.handleMessage(id, socket, { type: 'terminal-output', attachmentId: terminal.id, data: 'ready\n' }), true)
  terminal.write('echo ok\n')
  terminal.resize(100, 30)
  assert.deepEqual(messages.slice(1).map((message) => JSON.parse(message).type), ['terminal-input', 'terminal-resize'])
  const replacement = { readyState: 1, send: () => {} } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.1.0', replacement)
  assert.equal(output, 'ready\n')
  assert.equal(exitCode, -1)
  assert.equal(manager.unregister(id, replacement), true)
})

test('rejects an Agent terminal that exits before attachment completes', async () => {
  const manager = new AgentManager()
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  const attachment = manager.attachTerminal(id, 'dev', 80, 24, true)
  const request = JSON.parse(messages[0])
  assert.equal(manager.handleMessage(id, socket, { type: 'terminal-exit', attachmentId: request.attachmentId, exitCode: 1 }), true)
  await assert.rejects(attachment, /exited before attaching/)
  assert.equal(manager.unregister(id, socket), true)
})
