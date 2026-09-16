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
  assert.equal(
    manager.handleMessage(id, { readyState: 1 } as WebSocket, {
      type: 'tmux-result',
      requestId: request.requestId,
      stdout: 'other\n',
      stderr: '',
    }),
    false,
  )
  assert.equal(
    manager.handleMessage(id, socket, {
      type: 'tmux-result',
      requestId: request.requestId,
      stdout: 'dev\n',
      stderr: '',
    }),
    true,
  )
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
  assert.equal(
    manager.handleMessage(id, socket, {
      type: 'shell-result',
      requestId: request.requestId,
      stdout: 'ready',
      stderr: '',
      exitCode: 0,
    }),
    true,
  )
  assert.deepEqual(await result, { stdout: 'ready', stderr: '', exitCode: 0 })
  assert.equal(manager.unregister(id, socket), true)
})

test('streams file uploads to the matching Agent socket', async () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  async function* source() {
    yield Buffer.from('hello agent')
  }
  const upload = manager.uploadFile(id, '/tmp/agent-upload.txt', source())
  await new Promise((resolve) => setImmediate(resolve))
  const start = JSON.parse(messages[0])
  assert.equal(start.type, 'file-upload-start')
  assert.equal(manager.handleMessage(id, socket, { type: 'file-upload-ready', uploadId: start.uploadId }), true)
  await new Promise((resolve) => setImmediate(resolve))
  const chunk = JSON.parse(messages[1])
  assert.equal(chunk.type, 'file-upload-chunk')
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'hello agent')
  assert.equal(manager.handleMessage(id, socket, { type: 'file-upload-ack', uploadId: start.uploadId }), true)
  await new Promise((resolve) => setImmediate(resolve))
  const end = JSON.parse(messages[2])
  assert.equal(end.type, 'file-upload-end')
  assert.equal(manager.handleMessage(id, socket, { type: 'file-upload-result', uploadId: start.uploadId }), true)
  await upload
  assert.equal(manager.unregister(id, socket), true)
})

test('rejects an Agent upload error before the upload is ready', async () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  async function* source() {
    yield Buffer.from('hello agent')
  }
  const upload = manager.uploadFile(id, '/tmp/agent-upload.txt', source())
  await new Promise((resolve) => setImmediate(resolve))
  const start = JSON.parse(messages[0])
  assert.equal(
    manager.handleMessage(id, socket, {
      type: 'file-upload-error',
      uploadId: start.uploadId,
      message: 'Permission denied',
    }),
    true,
  )
  await assert.rejects(upload, /Permission denied/)
  assert.equal(manager.unregister(id, socket), true)
})

test('does not send an Agent upload chunk after an early upload error', async () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const messages: string[] = []
  let release: () => void = () => {}
  const sourceReady = new Promise<void>((resolve) => {
    release = resolve
  })
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  async function* source() {
    await sourceReady
    yield Buffer.from('hello agent')
  }
  const upload = manager.uploadFile(id, '/tmp/agent-upload.txt', source())
  await new Promise((resolve) => setImmediate(resolve))
  const start = JSON.parse(messages[0])
  assert.equal(manager.handleMessage(id, socket, { type: 'file-upload-ready', uploadId: start.uploadId }), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    manager.handleMessage(id, socket, { type: 'file-upload-error', uploadId: start.uploadId, message: 'Write failed' }),
    true,
  )
  release()
  await assert.rejects(upload, /Write failed/)
  assert.equal(messages.length, 1)
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
  assert.equal(
    manager.handleMessage(id, socket, {
      type: 'terminal-attached',
      requestId: request.requestId,
      attachmentId: '00000000-0000-4000-8000-000000000000',
      pid: 42,
    }),
    false,
  )
  assert.equal(
    manager.handleMessage(id, socket, {
      type: 'terminal-attached',
      requestId: request.requestId,
      attachmentId: request.attachmentId,
      pid: 42,
    }),
    true,
  )
  const terminal = await attachment
  let output = ''
  let exitCode: number | null = null
  terminal.onData((data) => {
    output += data
  })
  terminal.onExit((code) => {
    exitCode = code
  })
  assert.equal(
    manager.handleMessage(id, { readyState: 1 } as WebSocket, {
      type: 'terminal-output',
      attachmentId: terminal.id,
      data: 'wrong',
    }),
    false,
  )
  assert.equal(
    manager.handleMessage(id, socket, { type: 'terminal-output', attachmentId: terminal.id, data: 'ready\n' }),
    true,
  )
  terminal.write('echo ok\n')
  terminal.resize(100, 30)
  assert.deepEqual(
    messages.slice(1).map((message) => JSON.parse(message).type),
    ['terminal-input', 'terminal-resize'],
  )
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
  assert.equal(
    manager.handleMessage(id, socket, { type: 'terminal-exit', attachmentId: request.attachmentId, exitCode: 1 }),
    true,
  )
  await assert.rejects(attachment, /exited before attaching/)
  assert.equal(manager.unregister(id, socket), true)
})

test('persists Agent history across Gateway restart with restricted permissions', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-agent-history-'))
  const historyPath = path.join(configDir, 'agent-history.json')
  t.after(async () => {
    await rm(configDir, { recursive: true, force: true })
  })
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
  const stored = JSON.parse(await readFile(historyPath, 'utf8')) as {
    agents: { id: string; online: boolean; version: string }[]
  }
  const storedAgent = stored.agents.find((agent) => agent.id === id)
  assert.equal(storedAgent?.id, id)
  assert.equal(storedAgent?.online, true)
  assert.equal(storedAgent?.version, '1.1.0')
  assert.equal((await stat(configDir)).mode & 0o777, 0o700)
  assert.equal((await stat(historyPath)).mode & 0o777, 0o600)
  assert.equal(restarted.unregister(id, replacement), true)
})

test('relays VNC frames between browser socket and agent socket', () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const agentMessages: (string | Buffer)[] = []
  const agentSocket = {
    readyState: 1,
    send: (message: string | Buffer) => agentMessages.push(message),
  } as unknown as WebSocket
  const browserMessages: (string | Buffer)[] = []
  const browserSocket = {
    readyState: 1,
    send: (data: Buffer) => browserMessages.push(data),
    close: () => {},
  } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', agentSocket)
  assert.equal(manager.openVnc(id, 'conn-1', 5900, browserSocket), true)
  assert.deepEqual(JSON.parse(agentMessages[0] as string), {
    type: 'vnc-open',
    connectionId: 'conn-1',
    port: 5900,
  })
  // 浏览器→agent 下行是二进制帧：vnc-data <connectionId>\n + 原始字节
  manager.sendVncData('conn-1', Buffer.from('RFB 003.008\n'))
  assert.deepEqual(agentMessages[1], Buffer.from('vnc-data conn-1\nRFB 003.008\n'))
  // agent→浏览器上行同样是二进制帧，剥离 header 后直发浏览器 socket
  const frame = Buffer.from([0, 1, 2, 3])
  manager.handleVncBinary(id, agentSocket, Buffer.concat([Buffer.from('vnc-data conn-1\n'), frame]))
  assert.deepEqual(browserMessages[0], frame)
  // 别的 socket/连接冒充的帧被丢弃
  manager.handleVncBinary(id, { readyState: 1 } as WebSocket, Buffer.from('vnc-data conn-1\nxx'))
  manager.handleVncBinary(id, agentSocket, Buffer.from('vnc-data conn-x\nxx'))
  manager.handleVncBinary(id, agentSocket, Buffer.from('no-header'))
  assert.equal(browserMessages.length, 1)
  // 旧版 agent 的 base64 JSON vnc-data 仍能转发
  assert.equal(
    manager.handleMessage(id, agentSocket, {
      type: 'vnc-data',
      connectionId: 'conn-1',
      data: frame.toString('base64'),
    }),
    true,
  )
  assert.equal(browserMessages.length, 2)
  assert.equal(manager.unregister(id, agentSocket), true)
})

test('closes browser VNC sockets when the agent disconnects', () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const agentSocket = { readyState: 1, send: () => {} } as unknown as WebSocket
  const closed: (string | undefined)[] = []
  const browserSocket = {
    readyState: 1,
    send: () => {},
    close: (_code?: number, reason?: string) => closed.push(reason),
  } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', agentSocket)
  assert.equal(manager.openVnc(id, 'conn-2', 5900, browserSocket), true)
  assert.equal(manager.openVnc('missing-agent', 'conn-x', 5900, browserSocket), false)
  manager.unregister(id, agentSocket)
  assert.equal(closed.length, 1)
  assert.match(closed[0] || '', /disconnected/i)
})

test('closeVnc asks the agent to drop the TCP connection', () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const agentMessages: string[] = []
  const agentSocket = { readyState: 1, send: (message: string) => agentMessages.push(message) } as unknown as WebSocket
  const browserSocket = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', agentSocket)
  assert.equal(manager.openVnc(id, 'conn-3', 5901, browserSocket), true)
  manager.closeVnc('conn-3')
  assert.deepEqual(JSON.parse(agentMessages[1]), { type: 'vnc-close', connectionId: 'conn-3' })
  assert.equal(manager.handleMessage(id, agentSocket, { type: 'vnc-data', connectionId: 'conn-3', data: '' }), true)
  assert.equal(manager.unregister(id, agentSocket), true)
})
