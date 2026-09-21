import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { getSecurityWarnings, isLoopbackHost, isTmuxVersionSupported } from './security.js'

test('recognizes loopback hosts', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)
})
test('uses the tmux security baseline', () => {
  assert.equal(isTmuxVersionSupported('tmux 3.6a'), false)
  assert.equal(isTmuxVersionSupported('tmux 3.6b'), true)
  assert.equal(isTmuxVersionSupported('tmux 3.7c'), true)
  assert.equal(isTmuxVersionSupported('tmux 3.3a-3'), false)
  assert.equal(isTmuxVersionSupported(null), false)
})
test('reports unsafe gateway deployment settings', () => {
  assert.deepEqual(
    getSecurityWarnings({ host: '0.0.0.0', authEnabled: false, encryptedTransport: false, tmuxVersion: 'tmux 3.3a' }),
    [
      'Authentication is disabled; anyone who can reach the Gateway can control terminal sessions.',
      'Gateway is listening on 0.0.0.0 without an encrypted transport; use HTTPS/WSS, a VPN, or an SSH tunnel.',
      'tmux 3.3a is below the recommended security baseline 3.6b; upgrade tmux or install a distro-patched package.',
    ],
  )
})
test('does not warn about encrypted loopback deployment with a supported tmux', () => {
  assert.deepEqual(
    getSecurityWarnings({ host: '127.0.0.1', authEnabled: true, encryptedTransport: true, tmuxVersion: 'tmux 3.7c' }),
    [],
  )
  assert.deepEqual(
    getSecurityWarnings({
      host: '127.0.0.1',
      authEnabled: true,
      encryptedTransport: false,
      tmuxVersion: 'tmux 3.7c',
      passwordChangeRequired: true,
    }),
    ['The default admin password is still active; change it before exposing the Gateway beyond localhost.'],
  )
})
