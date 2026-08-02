import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import type { WebSocket } from 'ws'
import { AgentManager } from './agent-manager.js'

test('keeps a replacement agent connected when the previous socket closes', () => {
  const id = `agent-${Date.now()}-${Math.random()}`
  const first = {} as WebSocket
  const second = {} as WebSocket
  const manager = new AgentManager({ historyPath: null })
  const registered = manager.register(id, 'agent', '127.0.0.1', '1.0.0', first)
  const repeated = manager.register(id, 'agent-renamed', '127.0.0.2', '1.0.1', first)
  assert.equal(repeated.name, 'agent-renamed')
  assert.equal(repeated.address, '127.0.0.2')
  assert.equal(repeated.version, '1.0.1')
  assert.equal(repeated.connectedAt, registered.connectedAt)
  assert.equal(repeated.reconnectCount, 0)
  manager.register(id, 'agent', '127.0.0.1', '1.1.0', second)
  assert.equal(manager.unregister(id, first), false)
  assert.equal(manager.heartbeat(id, second, '1.1.1'), true)
  const active = manager.getAgent(id)
  assert.equal(active?.online, true)
  assert.equal(active?.version, '1.1.1')
  assert.equal(active?.reconnectCount, 1)
  assert.equal(manager.unregister(id, second), true)
  const disconnected = manager.getAgentStatus(id)
  assert.equal(disconnected?.online, false)
  assert.equal(disconnected?.disconnectReason, 'Disconnected')
})

test('routes tmux commands to the matching Agent socket', async () => {
  const manager = new AgentManager({ historyPath: null })
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

test('routes shell commands to the matching Agent socket', async () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  const result = manager.executeShell(id, 'printf ready')
  const request = JSON.parse(messages[0])
  assert.equal(request.type, 'shell')
  assert.equal(request.command, 'printf ready')
  assert.equal(manager.handleMessage(id, socket, { type: 'shell-result', requestId: request.requestId, stdout: 'ready', stderr: '', exitCode: 0 }), true)
  assert.deepEqual(await result, { stdout: 'ready', stderr: '', exitCode: 0 })
  assert.equal(manager.unregister(id, socket), true)
})

test('does not route commands through a timed out Agent socket', async () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  ;((manager as any).agents.get(id) as { lastSeenAt: string }).lastSeenAt = new Date(0).toISOString()
  assert.equal(manager.getAgent(id)?.online, false)
  await assert.rejects(manager.executeTmux(id, ['list-sessions']), /not connected/)
  await assert.rejects(manager.attachTerminal(id, 'dev', 80, 24, true), /not connected/)
  assert.deepEqual(messages, [])
  assert.equal(manager.unregister(id, socket), true)
})

test('forwards isolated terminal streams and closes them on Agent reconnect', async () => {
  const manager = new AgentManager({ historyPath: null })
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
  const manager = new AgentManager({ historyPath: null })
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

test('persists Agent history across Gateway restart with restricted permissions', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-agent-history-'))
  const historyPath = path.join(configDir, 'agent-history.json')
  t.after(async () => { await rm(configDir, { recursive: true, force: true }) })
  const id = `agent-${Date.now()}-${Math.random()}`
  const first = { readyState: 1, send: () => {} } as unknown as WebSocket
  const initial = new AgentManager({ historyPath })
  initial.register(id, 'agent', '127.0.0.1', '1.0.0', first)
  const restarted = new AgentManager({ historyPath })
  const disconnected = restarted.getAgentStatus(id)
  assert.equal(disconnected?.online, false)
  assert.equal(disconnected?.connectedAt, null)
  assert.equal(disconnected?.disconnectReason, 'Gateway restarted')
  const replacement = { readyState: 1, send: () => {} } as unknown as WebSocket
  const reconnected = restarted.register(id, 'agent', '127.0.0.1', '1.1.0', replacement)
  assert.equal(reconnected.reconnectCount, 1)
  const stored = JSON.parse(await readFile(historyPath, 'utf8')) as { agents: { id: string; online: boolean; version: string }[] }
  const storedAgent = stored.agents.find((agent) => agent.id === id)
  assert.equal(storedAgent?.id, id)
  assert.equal(storedAgent?.online, true)
  assert.equal(storedAgent?.version, '1.1.0')
  assert.equal((await stat(configDir)).mode & 0o777, 0o700)
  assert.equal((await stat(historyPath)).mode & 0o777, 0o600)
  assert.equal(restarted.unregister(id, replacement), true)
})
