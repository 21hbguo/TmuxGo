import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import { upsertRemoteHost } from './lib/hosts.js'
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const bridgePath = fileURLToPath(new URL('./ssh-bridge.ts', import.meta.url))
function runBridge(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [tsxCli, bridgePath, ...args], { encoding: 'utf8', timeout: 15000, env: { ...process.env, TMUXGO_SSH_ALLOWED_HOSTS: '', TMUXGO_SSH_USER_MAP: '', TMUX_WEB_ALLOWED_SESSIONS: '', TMUXGO_CONFIG_DIR: '', ...env } })
}
test('prints help and exits 0 for --help', () => {
  const result = runBridge(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /attach/)
})
test('exits 1 with usage hint when no command is given', () => {
  const result = runBridge([])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ssh tmuxgo@gateway attach/)
})
test('rejects invalid host id', () => {
  const result = runBridge(['attach', '--host', 'bad host', '--session', 'dev'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid host id/)
})
test('rejects remote host not allowed by TMUXGO_SSH_ALLOWED_HOSTS', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-ssh-'))
  const savedConfigDir = process.env.TMUXGO_CONFIG_DIR
  try {
    process.env.TMUXGO_CONFIG_DIR = configDir
    await upsertRemoteHost({ id: 'hlsj', name: 'hlsj', address: '127.0.0.1', user: 'guo' })
    process.env.TMUXGO_CONFIG_DIR = savedConfigDir
    const result = runBridge(['attach', '--host', 'hlsj', '--session', 'dev'], { TMUXGO_CONFIG_DIR: configDir, TMUXGO_SSH_ALLOWED_HOSTS: 'other' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not allowed/)
  } finally {
    process.env.TMUXGO_CONFIG_DIR = savedConfigDir
    await rm(configDir, { recursive: true, force: true })
  }
})
test('rejects unknown remote host with Host not found', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-ssh-'))
  try {
    const result = runBridge(['attach', '--host', 'ghost', '--session', 'dev'], { TMUXGO_CONFIG_DIR: configDir })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Host not found/)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})
