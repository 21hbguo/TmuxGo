import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execHostShell, execTmux } from './tmux-executor.js'
import { agentManager } from '../agent-manager.js'
import { upsertRemoteHost } from './hosts.js'

const execFileAsync = promisify(execFile)

test('executes local tmux and shell commands through the local host', async () => {
  const sessionName = `tmuxgo-executor-${process.pid}-${Date.now()}`
  try {
    const tmux = await execTmux('local', ['new-session', '-d', '-s', sessionName, 'sh', '-lc', 'printf agent; sleep 30'])
    assert.equal(tmux.host.id, 'local')
    const panes = await execTmux('local', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    assert.match(panes.stdout, /^%\d+\n?$/)
    const shell = await execHostShell('local', 'printf shell')
    assert.equal(shell.host.id, 'local')
    assert.equal(shell.stdout, 'shell')
  } finally {
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
  }
})

test('routes tmux and shell scans through an Agent host', async () => {
  const hostId = `agent-executor-${process.pid}-${Date.now()}`
  const messages: string[] = []
  const socket = { readyState: 1, send: (message: string) => {
    messages.push(message)
    const request = JSON.parse(message)
    if (request.type === 'tmux') void Promise.resolve().then(() => agentManager.handleMessage(hostId, socket as any, { type: 'tmux-result', requestId: request.requestId, stdout: 'agent-pane\n', stderr: '' }))
    if (request.type === 'shell') void Promise.resolve().then(() => agentManager.handleMessage(hostId, socket as any, { type: 'shell-result', requestId: request.requestId, stdout: 'agent-shell', stderr: '', exitCode: 0 }))
  } } as any
  agentManager.register(hostId, 'agent-host', '127.0.0.1', '1.0.0', socket)
  const tmux = await execTmux(hostId, ['list-panes'])
  const shell = await execHostShell(hostId, 'printf shell')
  assert.equal(tmux.host.id, hostId)
  assert.equal(tmux.stdout, 'agent-pane\n')
  assert.equal(shell.host.id, hostId)
  assert.equal(shell.stdout, 'agent-shell')
  assert.deepEqual(messages.map((message) => JSON.parse(message).type), ['tmux', 'shell'])
  assert.equal(agentManager.unregister(hostId, socket), true)
})

test('normalizes an unavailable SSH host for tmux and shell execution', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-executor-ssh-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  await upsertRemoteHost({ id: 'ssh-unavailable', address: '127.0.0.1', user: 'nobody', port: 1 })
  await assert.rejects(execTmux('ssh-unavailable', ['list-panes'], { timeoutMs: 1000 }), /SSH connection timed out|SSH network is unreachable|Connection refused/)
  await assert.rejects(execHostShell('ssh-unavailable', 'printf shell', { timeoutMs: 1000 }), /SSH connection timed out|SSH network is unreachable|Connection refused/)
})
