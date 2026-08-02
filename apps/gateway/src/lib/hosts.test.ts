import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'

test('migrates host credentials out of hosts.json with restricted permissions', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-hosts-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  await writeFile(path.join(configDir, 'hosts.json'), JSON.stringify({ version: 1, hosts: [{ id: 'remote', name: 'remote', address: 'remote.example', user: 'guo', port: 22, password: 'legacy-password', passwordEnv: 'SSH_PASSWORD' }] }))
  const hosts = await import(`./hosts.js?migration-test=${Date.now()}-${Math.random()}`)
  const [host] = await hosts.listRemoteHosts()
  const credentials = await hosts.getHostCredentials('remote')
  assert.equal((host as Record<string, unknown>).password, undefined)
  assert.equal((host as Record<string, unknown>).passwordEnv, undefined)
  assert.equal(credentials.password, 'legacy-password')
  assert.equal(credentials.passwordEnv, 'SSH_PASSWORD')
  await hosts.upsertRemoteHost({ id: 'remote', name: 'remote', address: 'remote.example', user: 'guo', privateKeyPath: '/home/guo/.ssh/id_ed25519', useAgent: false, jumpHost: 'jump@bastion.example', knownHostsPolicy: 'strict' })
  const updated = await hosts.getHostById('remote')
  const updatedCredentials = await hosts.getHostCredentials('remote')
  assert.deepEqual({ useAgent: updated?.useAgent, jumpHost: updated?.jumpHost, knownHostsPolicy: updated?.knownHostsPolicy }, { useAgent: false, jumpHost: 'jump@bastion.example', knownHostsPolicy: 'strict' })
  assert.equal(updatedCredentials.privateKeyPath, '/home/guo/.ssh/id_ed25519')
  const hostConfig = await readFile(path.join(configDir, 'hosts.json'), 'utf8')
  assert.equal(hostConfig.includes('legacy-password'), false)
  assert.equal(hostConfig.includes('id_ed25519'), false)
  assert.equal((await stat(configDir)).mode & 0o777, 0o700)
  assert.equal((await stat(path.join(configDir, 'hosts.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(configDir, 'host-credentials.json'))).mode & 0o777, 0o600)
  await rm(configDir, { recursive: true, force: true })
})
