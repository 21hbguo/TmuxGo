import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
import { createTerminalAttachment, setPtySpawnForTest } from './terminal-attachment.js'
import { upsertRemoteHost } from './hosts.js'
import { agentManager } from '../agent-manager.js'

function fakePty(pid: number) {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = []
  return {
    pid,
    cols: 80,
    rows: 24,
    process: 'tmux',
    handleFlowControl: false,
    write: () => {},
    resize: () => {},
    kill: () => {},
    clear: () => {},
    pause: () => {},
    resume: () => {},
    onData: (listener: (data: string) => void) => {
      dataListeners.push(listener)
      return { dispose: () => {} }
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(listener)
      return { dispose: () => {} }
    },
    emitData: (data: string) => {
      for (const listener of dataListeners) listener(data)
    },
    emitExit: (exitCode: number) => {
      for (const listener of exitListeners) listener({ exitCode })
    },
  } as IPty & { emitData: (data: string) => void; emitExit: (exitCode: number) => void }
}
function withConfigDir(t: { after: (fn: () => void | Promise<void>) => void }) {
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  return async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-attach-'))
    process.env.TMUXGO_CONFIG_DIR = configDir
    t.after(async () => {
      if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
      else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    })
  }
}
test('creates a remote SSH attachment with expected ssh arguments', async (t) => {
  await withConfigDir(t)()
  await upsertRemoteHost({ id: 'remote', address: 'remote.example', user: 'guo', port: 2222, privateKeyPath: '/home/guo/.ssh/id_ed25519' })
  const spawned: Array<{ file: string; args: string[] }> = []
  const fakes: Array<ReturnType<typeof fakePty>> = []
  setPtySpawnForTest((file, args, _options) => {
    spawned.push({ file, args })
    const fake = fakePty(100)
    fakes.push(fake)
    return fake
  })
  const attachment = await createTerminalAttachment({ hostId: 'remote', sessionName: 'dev', cols: 100, rows: 30, exclusive: false })
  assert.equal(attachment.pid, 100)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, 'ssh')
  assert.ok(spawned[0].args.includes('-p'))
  assert.ok(spawned[0].args.includes('2222'))
  assert.ok(spawned[0].args.includes('guo@remote.example'))
  assert.ok(spawned[0].args.includes('-i'))
  assert.ok(spawned[0].args.includes('/home/guo/.ssh/id_ed25519'))
  assert.ok(spawned[0].args.includes('StrictHostKeyChecking=accept-new'))
  assert.ok(spawned[0].args.includes('tmux'))
  assert.ok(spawned[0].args.includes('attach'))
  assert.ok(spawned[0].args.includes('-f'))
  assert.ok(spawned[0].args.includes('ignore-size,active-pane'))
  assert.ok(spawned[0].args.includes('-t'))
  assert.ok(spawned[0].args.includes('dev'))
  attachment.kill()
})
test('creates a local tmux attachment and adapts pty events', async () => {
  const spawned: Array<{ file: string; args: string[] }> = []
  const fakes: Array<ReturnType<typeof fakePty>> = []
  setPtySpawnForTest((file, args, _options) => {
    spawned.push({ file, args })
    const fake = fakePty(200)
    fakes.push(fake)
    return fake
  })
  const attachment = await createTerminalAttachment({ hostId: 'local', sessionName: 'work', cols: 120, rows: 40, exclusive: true })
  assert.equal(attachment.pid, 200)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, 'tmux')
  assert.ok(spawned[0].args.includes('attach'))
  assert.ok(spawned[0].args.includes('-t'))
  assert.ok(spawned[0].args.includes('work'))
  assert.ok(!spawned[0].args.includes('-f'))
  let output = ''
  attachment.onData((chunk) => {
    output += chunk
  })
  let exitCode: number | null = null
  attachment.onExit((code) => {
    exitCode = code
  })
  fakes[0].emitData('pane-output')
  fakes[0].emitExit(5)
  assert.equal(output, 'pane-output')
  assert.equal(exitCode, 5)
  attachment.kill()
})
test('creates an agent attachment and adapts onExit to a plain exit code', async (t) => {
  await withConfigDir(t)()
  const hostId = `agent-attach-${process.pid}-${Date.now()}`
  let attachmentId = ''
  const socket = { readyState: 1, send: (message: string) => {
    const request = JSON.parse(message)
    if (request.type === 'terminal-attach') {
      attachmentId = request.attachmentId
      void Promise.resolve().then(() => agentManager.handleMessage(hostId, socket as any, { type: 'terminal-attached', requestId: request.requestId, attachmentId: request.attachmentId, pid: 4242 }))
    }
  } } as any
  agentManager.register(hostId, 'agent-host', '127.0.0.1', '1.0.0', socket)
  const attachment = await createTerminalAttachment({ hostId, sessionName: 'dev', cols: 80, rows: 24, exclusive: false })
  assert.equal(attachment.pid, 4242)
  let exitCode: number | null = null
  attachment.onExit((code) => {
    exitCode = code
  })
  agentManager.handleMessage(hostId, socket, { type: 'terminal-exit', attachmentId, exitCode: 7 })
  assert.equal(exitCode, 7)
  assert.equal(agentManager.unregister(hostId, socket), true)
})
