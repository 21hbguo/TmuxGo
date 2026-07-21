import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldResumeFromContinuity } from '../apps/frontend/src/lib/session-continuity-policy'

test('uses reconnect and new-device continuity settings independently', () => {
  assert.equal(shouldResumeFromContinuity(true, true, false, true), true)
  assert.equal(shouldResumeFromContinuity(true, true, false, false), false)
  assert.equal(shouldResumeFromContinuity(true, false, true, true), false)
  assert.equal(shouldResumeFromContinuity(true, false, true, false), true)
  assert.equal(shouldResumeFromContinuity(false, true, true, false), false)
})
