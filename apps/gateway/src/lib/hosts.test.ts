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
  await hosts.upsertRemoteHost({ id: 'remote', name: 'remote', address: 'remote.example', user: 'guo', privateKeyPath: '/home/guo/.ssh/id_ed25519', groups: ['research', 'gpu'], tags: ['production', 'gpu'], favorite: true, useAgent: false, jumpHost: 'jump@bastion.example', knownHostsPolicy: 'strict', tmuxPath: '/opt/tmux/bin/tmux' })
  const updated = await hosts.getHostById('remote')
  const updatedCredentials = await hosts.getHostCredentials('remote')
  assert.deepEqual({ groups: updated?.groups, tags: updated?.tags, favorite: updated?.favorite, useAgent: updated?.useAgent, jumpHost: updated?.jumpHost, knownHostsPolicy: updated?.knownHostsPolicy, tmuxPath: updated?.tmuxPath }, { groups: ['research', 'gpu'], tags: ['production', 'gpu'], favorite: true, useAgent: false, jumpHost: 'jump@bastion.example', knownHostsPolicy: 'strict', tmuxPath: '/opt/tmux/bin/tmux' })
  await hosts.upsertRemoteHost({ id: 'remote', name: 'remote', address: 'remote.example', user: 'guo', tmuxPath: 'evil; rm -rf /' })
  assert.equal((await hosts.getHostById('remote'))?.tmuxPath, '')
  assert.equal(updatedCredentials.privateKeyPath, '/home/guo/.ssh/id_ed25519')
  const hostConfig = await readFile(path.join(configDir, 'hosts.json'), 'utf8')
  assert.equal(hostConfig.includes('legacy-password'), false)
  assert.equal(hostConfig.includes('id_ed25519'), false)
  assert.equal((await stat(configDir)).mode & 0o777, 0o700)
  assert.equal((await stat(path.join(configDir, 'hosts.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(configDir, 'host-credentials.json'))).mode & 0o777, 0o600)
  await rm(configDir, { recursive: true, force: true })
})
test('saves a full host config replacing hosts and credentials', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-config-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  const hosts = await import(`./hosts.js?config-test=${Date.now()}-${Math.random()}`)
  const saved = await hosts.saveHostConfig({
    hosts: { version: 2, hosts: [{ id: 'alpha', name: 'Alpha', address: 'alpha.example', user: 'guo', port: 22 }] } as any,
    credentials: { version: 1, credentials: { alpha: { password: 'secret', passwordEnv: '', privateKeyPath: '' } } },
  })
  assert.equal(saved.hosts.hosts.length, 1)
  assert.equal(saved.hosts.hosts[0].id, 'alpha')
  assert.equal(saved.hosts.hosts[0].name, 'Alpha')
  assert.equal(saved.credentials.credentials.alpha.password, 'secret')
  const reloaded = await hosts.readHostConfig()
  assert.equal(reloaded.hosts.hosts[0].id, 'alpha')
  assert.equal(reloaded.credentials.credentials.alpha.password, 'secret')
  assert.equal((await readFile(path.join(configDir, 'hosts.json'), 'utf8')).includes('alpha.example'), true)
  assert.equal((await readFile(path.join(configDir, 'host-credentials.json'), 'utf8')).includes('secret'), true)
})
test('updates hosts without touching existing credentials', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-config-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  const hosts = await import(`./hosts.js?config-partial=${Date.now()}-${Math.random()}`)
  await hosts.saveHostConfig({
    hosts: { version: 2, hosts: [{ id: 'alpha', name: 'Alpha', address: 'alpha.example', user: 'guo', port: 22 }] } as any,
    credentials: { version: 1, credentials: { alpha: { password: 'keep-me', passwordEnv: '', privateKeyPath: '' } } },
  })
  const updated = await hosts.saveHostConfig({
    hosts: { version: 2, hosts: [{ id: 'beta', name: 'Beta', address: 'beta.example', user: 'guo', port: 22 }, { id: 'alpha', name: 'Alpha', address: 'alpha.example', user: 'guo', port: 22 }] } as any,
  })
  assert.equal(updated.hosts.hosts.length, 2)
  assert.equal(updated.credentials.credentials.alpha.password, 'keep-me')
  assert.equal((await hosts.readHostConfig()).credentials.credentials.alpha.password, 'keep-me')
})
test('rejects an invalid host config structure', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-host-config-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  const hosts = await import(`./hosts.js?config-invalid=${Date.now()}-${Math.random()}`)
  await assert.rejects(hosts.saveHostConfig({ hosts: { version: 1, hosts: [] } } as any), /Invalid host store/)
  await assert.rejects(hosts.saveHostConfig({ hosts: { version: 2, hosts: [{ id: 'local', name: 'Local', address: '127.0.0.1', user: 'guo', port: 22 }] } } as any), /Invalid host id/)
  await assert.rejects(hosts.saveHostConfig({ credentials: { version: 2, credentials: {} } } as any), /Invalid credential store/)
})
