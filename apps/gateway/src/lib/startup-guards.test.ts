import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { assertListenSafety } from './startup-guards.js'

const safe = { authEnabled: true, passwordChangeRequired: false, insecureModeAllowed: false }

test('refuses to expose a default-password gateway on a public interface', () => {
  assert.throws(
    () => assertListenSafety({ ...safe, host: '0.0.0.0', passwordChangeRequired: true }),
    /Refusing to expose a Gateway with the default password on 0\.0\.0\.0/,
  )
})

test('refuses to expose an unauthenticated gateway on a public interface', () => {
  assert.throws(
    () => assertListenSafety({ ...safe, host: '0.0.0.0', authEnabled: false }),
    /Refusing to expose an unauthenticated Gateway on 0\.0\.0\.0/,
  )
})

test('reports the default password first when both guards trip', () => {
  // 顺序有意义：先改密再谈认证，否则用户按"配认证"的提示走会绕过改密
  assert.throws(
    () =>
      assertListenSafety({
        host: '192.0.2.110',
        authEnabled: false,
        passwordChangeRequired: true,
        insecureModeAllowed: false,
      }),
    /default password/,
  )
})

test('allows loopback even with the default password and no auth', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', ' 127.0.0.1 '])
    assert.doesNotThrow(() =>
      assertListenSafety({ host, authEnabled: false, passwordChangeRequired: true, insecureModeAllowed: false }),
    )
})

test('allows a public interface once authentication is configured', () => {
  assert.doesNotThrow(() => assertListenSafety({ ...safe, host: '0.0.0.0' }))
  assert.doesNotThrow(() => assertListenSafety({ ...safe, host: '192.0.2.110' }))
})

test('allows an unauthenticated public interface only with the insecure opt-in', () => {
  assert.doesNotThrow(() =>
    assertListenSafety({
      host: '0.0.0.0',
      authEnabled: false,
      passwordChangeRequired: false,
      insecureModeAllowed: true,
    }),
  )
})
