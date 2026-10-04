import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebSocket } from 'ws'
import { agentManager } from '../agent-manager.js'
import { buildRemotePythonCommand, runRemoteFilePython } from './remote-file-command.js'

test('buildRemotePythonCommand picks python3||python and keeps args after -c', () => {
  const command = buildRemotePythonCommand('print(1)', ['/tmp/a b', "x'y"])
  // python3 优先、退回 python；两者都无打出标记 exit 127
  assert.ok(command.includes('command -v python3'))
  assert.ok(command.includes('command -v python'))
  // 不能出现 `-c 'script' -- arg`：'--' 会留在 sys.argv[1]
  assert.ok(!command.includes(' -- '))
  assert.ok(command.includes(`-c 'print(1)'`))
  assert.ok(command.includes(`'/tmp/a b'`))
  assert.ok(command.includes(`'x'\\''y'`))
})

test('normalizeRemoteFileErrorMessage friendly-fails on missing python', async () => {
  const { normalizeRemoteFileErrorMessage } = await import('./remote-file-command.js')
  assert.equal(
    normalizeRemoteFileErrorMessage('__TMUXGO_NO_PYTHON__\n', 'fallback'),
    'Remote host has no python3/python (file features need Python)',
  )
})

test('runRemoteFilePython goes through an online agent and cold-installs the rpc script', async () => {
  const hostId = `agent-rpc-${process.pid}-${Date.now()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket
  agentManager.register(hostId, 'agent', '127.0.0.1', '1.0.0', socket)
  try {
    const result = runRemoteFilePython<{ ok: boolean }>(hostId, 'print(1)', [])
    await new Promise((resolve) => setImmediate(resolve))
    // 第一发是 warm：执行缓存的 ~/.tmuxgo/file-rpc-<hash>.py
    const warm = JSON.parse(messages[0])
    assert.equal(warm.type, 'shell')
    assert.match(warm.command, /\.tmuxgo\/file-rpc-[a-f0-9]{12}\.py/)
    assert.ok(!warm.command.includes('import base64'))
    // warm 未命中（exit 75 + 标记）→ 第二发 cold：base64 落盘 + 原子改名 + exec
    agentManager.handleMessage(hostId, socket, {
      type: 'shell-result',
      requestId: warm.requestId,
      stdout: '',
      stderr: '__TMUXGO_RPC_COLD__\n',
      exitCode: 75,
    })
    await new Promise((resolve) => setImmediate(resolve))
    const cold = JSON.parse(messages[1])
    assert.equal(cold.type, 'shell')
    assert.ok(cold.command.includes(Buffer.from('print(1)', 'utf8').toString('base64')))
    assert.ok(cold.command.includes('os.replace'))
    agentManager.handleMessage(hostId, socket, {
      type: 'shell-result',
      requestId: cold.requestId,
      stdout: '{"ok":true}',
      stderr: '',
      exitCode: 0,
    })
    assert.deepEqual(await result, { ok: true })
  } finally {
    assert.equal(agentManager.unregister(hostId, socket), true)
  }
})

test('runRemoteFilePython rejects unknown hosts without agent or SSH record', async () => {
  await assert.rejects(runRemoteFilePython(`missing-${process.pid}-${Date.now()}`, 'print(1)', []), /not found/)
})
