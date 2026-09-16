import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeVncPort } from './vnc.js'

test('normalizeVncPort accepts display ports 5900-5999 and defaults to 5900', () => {
  assert.equal(normalizeVncPort(undefined), 5900)
  assert.equal(normalizeVncPort(''), 5900)
  assert.equal(normalizeVncPort('5900'), 5900)
  assert.equal(normalizeVncPort(5999), 5999)
  assert.equal(normalizeVncPort('5999'), 5999)
})

test('normalizeVncPort rejects ports outside the VNC display range', () => {
  for (const value of ['80', '443', '22', '0', '5899', '6000', '-1', 'abc', '5900.5'] as unknown[]) {
    assert.equal(normalizeVncPort(value), null, `expected ${String(value)} to be rejected`)
  }
})
