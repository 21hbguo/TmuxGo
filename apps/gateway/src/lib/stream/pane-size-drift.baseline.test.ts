import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 实测基线（guo / tmux 3.4 / scripts/repro-pane-size-drift.ts）：
 * both-exclusive  desk 120x36 vs win 80x23  driftRatio=1.0  (Δ +40,+13)
 * both-exclusive  phone 80x24 vs win 80x23  Δ (0,+1)  status 行
 * shared          desk 120x36 vs win 120x35 Δ (0,+1)
 * shared          phone 80x24 vs win 120x35  ignore-size 预期
 * 4 pane ×10 切换：pane 尺寸序列稳定（本布局无 flips）；漂移在 client↔window
 */

type Snap = { xterm: [number, number]; win: [number, number] }

function drift(s: Snap) {
  return s.xterm[0] !== s.win[0] || s.xterm[1] !== s.win[1]
}
function delta(s: Snap): [number, number] {
  return [s.xterm[0] - s.win[0], s.xterm[1] - s.win[1]]
}

test('both-exclusive: 后到的 80x24 独占把 window 拖到 80x23，desk xterm 120x36 持续漂移', () => {
  const snaps: Snap[] = Array.from({ length: 42 }, () => ({ xterm: [120, 36], win: [80, 23] }))
  assert.equal(snaps.filter(drift).length, 42)
  assert.deepEqual(delta(snaps[0]), [40, 13])
})

test('shared 对照: desk 仅 status 行 off-by-one（rows-1）', () => {
  const s: Snap = { xterm: [120, 36], win: [120, 35] }
  assert.equal(drift(s), true)
  assert.deepEqual(delta(s), [0, 1])
})

test('shared: phone ignore-size 保持自身 xterm，不跟随 window', () => {
  const s: Snap = { xterm: [80, 24], win: [120, 35] }
  assert.deepEqual(delta(s), [-40, -11])
})
