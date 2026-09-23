import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  getHostCredentials,
  getLocalHostRecord,
  getHostById,
  listAllHosts,
  listRemoteHosts,
  removeRemoteHost,
  upsertRemoteHost,
} from '../apps/gateway/src/lib/hosts'

test('host store keeps local host and persists sorted remote hosts', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-hosts-'))
  // listAllHosts 会合入 ~/.ssh/config 条目（os.homedir 取 $HOME）：
  // 连 HOME 一起隔离，否则断言受本机真实 ssh 主机污染
  const previousHome = process.env.HOME
  process.env.HOME = tempDir
  process.env.TMUXGO_CONFIG_DIR = tempDir
  try {
    const alpha = await upsertRemoteHost({ id: 'alpha', address: '10.0.0.1', user: 'guo', port: 2201 })
    const beta = await upsertRemoteHost({ id: 'beta', name: 'beta-node', address: '10.0.0.2', user: 'root' })
    assert.equal(alpha.port, 2201)
    assert.equal(beta.name, 'beta-node')
    const localHost = getLocalHostRecord()
    const allHosts = await listAllHosts()
    assert.equal(allHosts[0].id, localHost.id)
    assert.deepEqual(
      allHosts.slice(1).map((item) => item.id),
      ['alpha', 'beta'],
    )
    assert.equal((await getHostById('beta'))?.address, '10.0.0.2')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('upsertRemoteHost preserves secret fields when omitted', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-hosts-'))
  process.env.TMUXGO_CONFIG_DIR = tempDir
  try {
    const created = await upsertRemoteHost({
      id: 'edge',
      address: '192.168.0.10',
      user: 'admin',
      password: 'secret',
      passwordEnv: 'TMUXGO_EDGE_PASSWORD',
    })
    const updated = await upsertRemoteHost({
      id: 'edge',
      name: 'edge-prod',
      address: '192.168.0.11',
      user: 'deploy',
    })
    assert.equal((created as Record<string, unknown>).password, undefined)
    assert.equal((updated as Record<string, unknown>).password, undefined)
    assert.deepEqual(await getHostCredentials('edge'), {
      password: 'secret',
      passwordEnv: 'TMUXGO_EDGE_PASSWORD',
      privateKeyPath: '',
    })
    assert.equal(updated.name, 'edge-prod')
    assert.equal(updated.address, '192.168.0.11')
    assert.equal(updated.user, 'deploy')
    assert.notEqual(updated.updatedAt, created.updatedAt)
  } finally {
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('removeRemoteHost reports whether a remote host existed', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-hosts-'))
  process.env.TMUXGO_CONFIG_DIR = tempDir
  try {
    await upsertRemoteHost({ id: 'edge', address: '192.168.0.10', user: 'admin' })
    assert.equal(await removeRemoteHost('edge'), true)
    assert.equal(await removeRemoteHost('edge'), false)
    assert.deepEqual(await listRemoteHosts(), [])
  } finally {
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('upsertRemoteHost rejects reserved and invalid ids', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-hosts-'))
  process.env.TMUXGO_CONFIG_DIR = tempDir
  try {
    await assert.rejects(() => upsertRemoteHost({ id: 'local', address: '127.0.0.1', user: 'root' }), /Invalid host id/)
    await assert.rejects(
      () => upsertRemoteHost({ id: 'bad host', address: '127.0.0.1', user: 'root' }),
      /Invalid host id/,
    )
  } finally {
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(tempDir, { recursive: true, force: true })
  }
})
