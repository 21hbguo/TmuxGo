import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeVncPort, parseVncDisplays, parseVncProbe } from './vnc.js'

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

test('parseVncDisplays maps listening ports to displays and dedupes ipv6', () => {
  const stdout = [
    'LISTEN 0 5 127.0.0.1:5909 0.0.0.0:* users:(("Xtigervnc",pid=3802271,fd=9))',
    'LISTEN 0 5 [::1]:5909 [::]:* users:(("Xtigervnc",pid=3802271,fd=10))',
    'LISTEN 0 5 127.0.0.1:5900 0.0.0.0:*',
    'LISTEN 0 5 127.0.0.1:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
    '__procs__',
    '3802271 Xtigervnc Xtigervnc :9',
  ].join('\n')
  const displays = parseVncDisplays(stdout)
  assert.deepEqual(displays, [
    { display: 0, port: 5900, process: null, pid: null },
    { display: 9, port: 5909, process: 'Xtigervnc', pid: 3802271 },
  ])
})

test('parseVncDisplays aggregates rss over the server process subtree', () => {
  const stdout = [
    'LISTEN 0 5 127.0.0.1:5901 0.0.0.0:* users:(("vncserver",pid=100,fd=9))',
    '__procs__',
    // vncserver 是 perl 壳（pid=100），真实占用在 Xtigervnc 子树；999 与 100 无关不计入
    '100 1 vncserver /usr/bin/vncserver :1 5000',
    '101 100 Xtigervnc Xtigervnc :1 200000',
    '102 101 sh -c xstartup 3000',
    '999 1 sshd /usr/sbin/sshd 8000',
  ].join('\n')
  const displays = parseVncDisplays(stdout)
  assert.equal(displays.length, 1)
  assert.equal(displays[0].rssKB, 208000)
})

test('parseVncDisplays tolerates legacy ps output without ppid/rss columns', () => {
  const stdout = [
    'LISTEN 0 5 127.0.0.1:5902 0.0.0.0:* users:(("x11vnc",pid=55,fd=7))',
    '__procs__',
    '55 x11vnc x11vnc -display :0',
  ].join('\n')
  const displays = parseVncDisplays(stdout)
  assert.equal(displays[0].pid, 55)
  assert.equal(displays[0].rssKB, undefined)
})

test('parseVncDisplays leaves rssKB unset when the server pid is unknown', () => {
  const stdout = ['LISTEN 0 5 127.0.0.1:5903 0.0.0.0:*', '__procs__', '100 1 Xtigervnc Xtigervnc :3 12345'].join('\n')
  const displays = parseVncDisplays(stdout)
  assert.equal(displays[0].pid, null)
  assert.equal(displays[0].rssKB, undefined)
})
