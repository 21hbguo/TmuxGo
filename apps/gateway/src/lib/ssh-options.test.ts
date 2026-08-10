import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHostSshOptions } from './ssh-options.js'
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
  assert.deepEqual(buildHostSshOptions(host, { password: '', passwordEnv: '', privateKeyPath: '/home/deploy/.ssh/id_ed25519' }), ['-i', '/home/deploy/.ssh/id_ed25519', '-o', 'IdentityAgent=none', '-J', 'jump@bastion.example', '-o', 'StrictHostKeyChecking=yes'])
  assert.deepEqual(buildHostSshOptions({ ...host, useAgent: true, jumpHost: '', knownHostsPolicy: 'accept-new' }, { password: '', passwordEnv: '', privateKeyPath: '' }), ['-o', 'StrictHostKeyChecking=accept-new'])
  assert.deepEqual(buildHostSshOptions({ ...host, useAgent: true, jumpHost: '', knownHostsPolicy: 'off' }, { password: '', passwordEnv: '', privateKeyPath: '' }), ['-o', 'StrictHostKeyChecking=no'])
})
