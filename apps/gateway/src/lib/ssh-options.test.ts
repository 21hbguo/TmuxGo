import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildHostSshOptions,
  buildSshConfigArgs,
  buildSshPortArgs,
  getSshControlPath,
  getSshTarget,
} from './ssh-options.js'
import type { HostRecord } from './hosts.js'
import { resolveSshConfigPath } from './ssh-config.js'

const host: HostRecord = {
  id: 'edge',
  name: 'edge',
  address: 'edge.example',
  user: 'deploy',
  port: 22,
  auth: 'auto',
  groups: [],
  tags: [],
  favorite: false,
  useAgent: false,
  jumpHost: 'jump@bastion.example',
  knownHostsPolicy: 'strict',
  tmuxPath: '',
  createdAt: '',
  updatedAt: '',
}

test('builds SSH key, agent, jump host, and known hosts options', () => {
  assert.deepEqual(
    buildHostSshOptions(host, { password: '', passwordEnv: '', privateKeyPath: '/home/deploy/.ssh/id_ed25519' }),
    [
      '-i',
      '/home/deploy/.ssh/id_ed25519',
      '-o',
      'IdentityAgent=none',
      '-J',
      'jump@bastion.example',
      '-o',
      'StrictHostKeyChecking=yes',
    ],
  )
  assert.deepEqual(
    buildHostSshOptions(
      { ...host, useAgent: true, jumpHost: '', knownHostsPolicy: 'accept-new' },
      { password: '', passwordEnv: '', privateKeyPath: '' },
    ),
    ['-o', 'StrictHostKeyChecking=accept-new'],
  )
  assert.deepEqual(
    buildHostSshOptions(
      { ...host, useAgent: true, jumpHost: '', knownHostsPolicy: 'off' },
      { password: '', passwordEnv: '', privateKeyPath: '' },
    ),
    ['-o', 'StrictHostKeyChecking=no'],
  )
})

const aliasHost: HostRecord = {
  ...host,
  id: 'hlsj',
  source: 'sshconfig',
  configFile: '/home/x/.ssh/config',
  identityFile: '~/.ssh/id_hlsj',
}

test('sshconfig hosts connect via bare alias without translating connection params', async () => {
  // 只保留 StrictHostKeyChecking overlay；-i/-J/IdentityAgent 交给 ssh config 原生语义
  assert.deepEqual(buildHostSshOptions(aliasHost, { password: '', passwordEnv: '', privateKeyPath: '/ignored/key' }), [
    '-o',
    'StrictHostKeyChecking=yes',
  ])
  assert.deepEqual(buildSshPortArgs(aliasHost), [])
  assert.equal(getSshTarget(aliasHost), 'hlsj')
  assert.ok(getSshControlPath(aliasHost).endsWith('/alias-hlsj'))
  // -F 锚定根 config 而非 host.configFile（后者可能是 Include 子文件）
  assert.deepEqual(await buildSshConfigArgs(aliasHost), ['-F', await resolveSshConfigPath()])
  assert.deepEqual(await buildSshConfigArgs(host), [])
})

test('sshconfig alias anchors non-default root config via -F', async () => {
  const prev = process.env.TMUXGO_SSH_CONFIG
  process.env.TMUXGO_SSH_CONFIG = '/tmp/tmuxgo-custom-ssh-config'
  try {
    assert.deepEqual(await buildSshConfigArgs(aliasHost), ['-F', '/tmp/tmuxgo-custom-ssh-config'])
  } finally {
    if (prev === undefined) delete process.env.TMUXGO_SSH_CONFIG
    else process.env.TMUXGO_SSH_CONFIG = prev
  }
})

test('store hosts keep explicit port, target and socket naming', () => {
  assert.deepEqual(buildSshPortArgs(host), ['-p', '22'])
  assert.equal(getSshTarget(host), 'deploy@edge.example')
  assert.ok(getSshControlPath(host).endsWith('/deploy@edge.example:22'))
})
