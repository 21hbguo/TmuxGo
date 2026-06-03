import test from 'node:test'
import assert from 'node:assert/strict'
import { getAttachSnapshotDelays } from '../apps/gateway/src/lib/attach-snapshot'

test('getAttachSnapshotDelays starts with immediate capture attempt', () => {
  assert.deepEqual(getAttachSnapshotDelays(), [0,96,220])
})
