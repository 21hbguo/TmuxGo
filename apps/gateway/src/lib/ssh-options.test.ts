import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHostSshOptions, buildSshPortArgs, getSshControlPath, getSshTarget } from './ssh-options.js'
import type { HostRecord } from './hosts.js'

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

test('sshconfig hosts connect via bare alias without translating connection params', () => {
  // 只保留 StrictHostKeyChecking overlay；-i/-J/IdentityAgent 交给 ssh config 原生语义
  assert.deepEqual(buildHostSshOptions(aliasHost, { password: '', passwordEnv: '', privateKeyPath: '/ignored/key' }), [
    '-o',
    'StrictHostKeyChecking=yes',
  ])
  assert.deepEqual(buildSshPortArgs(aliasHost), [])
  assert.equal(getSshTarget(aliasHost), 'hlsj')
  assert.ok(getSshControlPath(aliasHost).endsWith('/alias-hlsj'))
})

test('store hosts keep explicit port, target and socket naming', () => {
  assert.deepEqual(buildSshPortArgs(host), ['-p', '22'])
  assert.equal(getSshTarget(host), 'deploy@edge.example')
  assert.ok(getSshControlPath(host).endsWith('/deploy@edge.example:22'))
})
