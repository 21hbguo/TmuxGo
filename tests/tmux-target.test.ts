import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionId, parseSessionRef } from '../apps/gateway/src/lib/tmux-target'

test('buildSessionId normalizes host id and keeps session name', () => {
  assert.equal(buildSessionId(' local-host ', 'workbench_1'), 'session-local-host-workbench_1')
})

test('buildSessionId rejects invalid host ids', () => {
  assert.throws(() => buildSessionId('bad host', 'demo'), /Invalid host id/)
})

test('parseSessionRef accepts plain session names', () => {
  assert.deepEqual(parseSessionRef('local', 'demo'), {
    hostId: 'local',
    sessionName: 'demo',
    sessionId: 'session-local-demo',
  })
})

test('parseSessionRef accepts host-prefixed session ids', () => {
  assert.deepEqual(parseSessionRef('edge-1', 'session-edge-1-demo'), {
    hostId: 'edge-1',
    sessionName: 'demo',
    sessionId: 'session-edge-1-demo',
  })
})

test('parseSessionRef maps legacy local ids to the current local session format', () => {
  assert.deepEqual(parseSessionRef('local', 'session-demo'), {
    hostId: 'local',
    sessionName: 'demo',
    sessionId: 'session-local-demo',
  })
})

test('parseSessionRef rejects ids from another host', () => {
  assert.throws(() => parseSessionRef('edge-1', 'session-local-demo'), /Session does not belong to host/)
})

test('parseSessionRef rejects invalid session names', () => {
  assert.throws(() => parseSessionRef('local', 'bad/name'), /Invalid session name/)
})
