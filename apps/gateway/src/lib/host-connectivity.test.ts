import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getHostConnectivity,
  recordHostConnectionFailure,
  removeHostConnectivity,
  setHostConnectivity,
} from './host-connectivity.js'

test('records the latest connection failure while retaining host diagnostics', () => {
  setHostConnectivity('edge', {
    status: 'online',
    latencyMs: 18,
    lastCheckedAt: '2026-08-02T00:00:00.000Z',
    dependencies: { tmux: true },
  })
  recordHostConnectionFailure('edge', 'SSH authentication failed')
  const health = getHostConnectivity('edge')
  assert.equal(health?.status, 'offline')
  assert.equal(health?.latencyMs, 18)
  assert.equal(health?.lastError, 'SSH authentication failed')
  assert.deepEqual(health?.dependencies, { tmux: true })
  assert.ok(Date.parse(health?.lastCheckedAt || ''))
  recordHostConnectionFailure('edge', 'tmux is not installed on target host')
  assert.equal(getHostConnectivity('edge')?.lastError, 'SSH authentication failed')
  removeHostConnectivity('edge')
  assert.equal(getHostConnectivity('edge'), undefined)
})
