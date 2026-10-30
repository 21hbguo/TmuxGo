import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VIEW_BASE_OPTION,
  VIEW_CLIENT_OPTION,
  VIEW_SESSION_PREFIX,
  hasViewSessionPrefix,
  normalizeViewId,
  viewSessionName,
} from './view-sessions.js'

test('view session name is stable and host/base scoped', () => {
  const a = viewSessionName('local', 'work', 'abcdefgh')
  assert.equal(a, viewSessionName('local', 'work', 'abcdefgh'))
  assert.match(a, new RegExp(`^${VIEW_SESSION_PREFIX}[0-9a-f]{16}$`))
  assert.notEqual(a, viewSessionName('local', 'work2', 'abcdefgh'))
  assert.notEqual(a, viewSessionName('devbox', 'work', 'abcdefgh'))
  assert.notEqual(a, viewSessionName('local', 'work', 'abcdefgi'))
  assert.ok(hasViewSessionPrefix(a))
})

test('view id accepts url-safe ids only', () => {
  assert.equal(normalizeViewId('abcdefgh'), 'abcdefgh')
  assert.equal(normalizeViewId(' A1b2C3d4_- '), 'A1b2C3d4_-')
  assert.equal(normalizeViewId('short'), null)
  assert.equal(normalizeViewId('has space'), null)
  assert.equal(normalizeViewId('has:colon'), null)
  assert.equal(normalizeViewId('x'.repeat(65)), null)
  assert.equal(normalizeViewId(42), null)
  assert.equal(normalizeViewId(null), null)
})

test('session option keys are the documented contract', () => {
  assert.equal(VIEW_BASE_OPTION, '@tmuxgo_view_base')
  assert.equal(VIEW_CLIENT_OPTION, '@tmuxgo_view_client')
})
