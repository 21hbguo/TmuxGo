import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeVncPort, parseVncProbe } from './vnc.js'

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

test('parseVncProbe reports a Linux host that needs x11vnc installed', () => {
  const status = parseVncProbe('os=Linux\nsession=x11\nsudo=ok\n')
  assert.equal(status.os, 'Linux')
  assert.equal(status.server, null)
  assert.equal(status.supported, true)
  assert.equal(status.sudo, true)
  assert.equal(status.listening, false)
  assert.equal(status.hint, 'need-install')
})

test('parseVncProbe detects a running server and wayland/macos hints', () => {
  const running = parseVncProbe('os=Linux\nsession=x11\nserver=x11vnc\nsudo=ok\nlistening=1\n')
  assert.equal(running.server, 'x11vnc')
  assert.equal(running.listening, true)
  assert.equal(running.hint, '')
  const wayland = parseVncProbe('os=Linux\nsession=wayland\nserver=x11vnc\n')
  assert.equal(wayland.hint, 'wayland-compositor')
  const mac = parseVncProbe('os=Darwin\nsession=\n')
  assert.equal(mac.server, 'builtin')
  assert.equal(mac.supported, true)
  assert.equal(mac.hint, 'macos-builtin')
  const windows = parseVncProbe('os=MINGW64_NT\n')
  assert.equal(windows.supported, false)
  assert.equal(windows.hint, 'unsupported-os')
})
