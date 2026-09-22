import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamCellEncoder } from './stream-cell.js'

function feedText(enc: StreamCellEncoder, text: string) {
  return enc.feed('output', text, enc.grid!.cols, enc.grid!.rows)
}

test('high dirty ratio prefers cell_diff not snapshot', () => {
  // 7/10 脏（0.7 >> 旧阈值 0.55）必须仍是 diff；仅整屏全变才 snapshot
  const enc2 = new StreamCellEncoder()
  enc2.reset(10, 1, true)
  const a = feedText(enc2, '0123456789')
  assert.equal(a.kind, 'frame')
  if (a.kind !== 'frame') return
  assert.equal(a.type, 'cell_snapshot_v2')
  enc2.markSent()
  const b = feedText(enc2, 'XXXXX67890')
  assert.equal(b.kind, 'frame')
  if (b.kind !== 'frame') return
  assert.equal(b.type, 'cell_diff_v2')
})

test('first attach and resync send snapshot', () => {
  const enc = new StreamCellEncoder()
  enc.reset(4, 1, true)
  const first = feedText(enc, 'ab')
  assert.equal(first.kind, 'frame')
  if (first.kind !== 'frame') return
  assert.equal(first.type, 'cell_snapshot_v2')
  enc.markSent()
  const resync = enc.feed('output_resync', 'cd', 4, 1)
  assert.equal(resync.kind, 'frame')
  if (resync.kind !== 'frame') return
  assert.equal(resync.type, 'cell_snapshot_v2')
})

test('cell mode resync boundary strips ESC[2J', async () => {
  const { RESYNC_RESET_SEQ } = await import('./stream-config.js')
  const stripped = RESYNC_RESET_SEQ.replace('\u001b[2J', '')
  assert.ok(RESYNC_RESET_SEQ.includes('\u001b[2J'))
  assert.ok(!stripped.includes('\u001b[2J'))
})
