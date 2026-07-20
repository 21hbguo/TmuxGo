import test from 'node:test'
import assert from 'node:assert/strict'
import { isRequestOriginAllowed } from '../apps/gateway/src/lib/request-origin'

test('request origin allows same host across frontend and gateway ports', () => {
  assert.equal(isRequestOriginAllowed('http://192.168.1.8:3000', '192.168.1.8:3001', ''), true)
  assert.equal(isRequestOriginAllowed('https://node.tailnet.ts.net', 'node.tailnet.ts.net:8443', ''), true)
})

test('request origin allows a loopback reverse proxy forwarded host', () => {
  assert.equal(isRequestOriginAllowed('https://node.tailnet.ts.net', '127.0.0.1:3001', '', 'node.tailnet.ts.net:8443', '127.0.0.1'), true)
  assert.equal(isRequestOriginAllowed('https://evil.example', '127.0.0.1:3001', '', 'node.tailnet.ts.net:8443', '127.0.0.1'), false)
  assert.equal(isRequestOriginAllowed('https://node.tailnet.ts.net', '127.0.0.1:3001', '', 'node.tailnet.ts.net:8443', '192.168.1.8'), false)
})

test('request origin rejects cross-site browser requests', () => {
  assert.equal(isRequestOriginAllowed('https://evil.example', '127.0.0.1:3001', ''), false)
  assert.equal(isRequestOriginAllowed('null', '127.0.0.1:3001', ''), false)
})

test('request origin supports explicit origins and originless clients', () => {
  assert.equal(isRequestOriginAllowed('https://console.example', '127.0.0.1:3001', 'https://console.example'), true)
  assert.equal(isRequestOriginAllowed(undefined, '127.0.0.1:3001', ''), true)
})
