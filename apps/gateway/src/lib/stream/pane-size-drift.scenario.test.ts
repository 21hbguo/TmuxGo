/**
 * 场景模型测试：双尺寸 client + 4 pane 来回切换时，xterm 与 tmux 尺寸记录结构与漂移判定。
 * 不依赖真实 tmux：用固定快照序列回放，锁定「何为 drift、何为 pane 抖动」。
 */
import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'

type PaneSnap = { paneId: string; w: number; h: number; active: boolean }
type Snap = {
  xterm: { cols: number; rows: number }
  win: { w: number; h: number }
  panes: PaneSnap[]
}

function driftOf(s: Snap) {
  return s.xterm.cols !== s.win.w || s.xterm.rows !== s.win.h
}

function paneFlips(snaps: Snap[], paneId: string) {
  const arr: Array<{ w: number; h: number }> = []
  for (const s of snaps) {
    const p = s.panes.find((x) => x.paneId === paneId)
    if (!p) continue
    const last = arr[arr.length - 1]
    if (!last || last.w !== p.w || last.h !== p.h) arr.push({ w: p.w, h: p.h })
  }
  return arr
}

/** 双 client 不同尺寸 + 4 pane 各切 10 次的最小回放 */
function buildScenario(): Snap[] {
  const snaps: Snap[] = []
  // desk 120x36 独占：window 跟 desk
  snaps.push({
    xterm: { cols: 120, rows: 36 },
    win: { w: 120, h: 36 },
    panes: [
      { paneId: '%1', w: 60, h: 18, active: true },
      { paneId: '%2', w: 60, h: 18, active: false },
      { paneId: '%3', w: 60, h: 18, active: false },
      { paneId: '%4', w: 60, h: 18, active: false },
    ],
  })
  // 切换 4 pane × 10：每次 select 后 window 短暂被 phone 主张再被 desk 拉回（现实 bug 形态）
  const ids = ['%1', '%2', '%3', '%4']
  for (let round = 0; round < 10; round++) {
    for (const id of ids) {
      // phone 80x24 抢占瞬间
      snaps.push({
        xterm: { cols: 120, rows: 36 }, // desk xterm 尚未跟随
        win: { w: 80, h: 24 },
        panes: ids.map((pid, i) => ({
          paneId: pid,
          w: pid === id ? 80 : 0,
          h: pid === id ? 24 : 0,
          active: pid === id,
        })),
      })
      // desk 拉回后
      snaps.push({
        xterm: { cols: 120, rows: 36 },
        win: { w: 120, h: 36 },
        panes: ids.map((pid) => ({
          paneId: pid,
          w: 60,
          h: 18,
          active: pid === id,
        })),
      })
    }
  }
  return snaps
}

test('S-repro: 双尺寸×4pane×10 切换，xterm 与 window 不一致记为 drift', () => {
  const snaps = buildScenario()
  const drifts = snaps.filter(driftOf)
  assert.ok(drifts.length > 0, '该场景应能采到 xterm/win 漂移')
  // desk xterm 固定 120x36 时，window 被 80x24 抢占即 drift
  assert.equal(drifts[0].win.w, 80)
  assert.equal(drifts[0].xterm.cols, 120)
})

test('S-repro: 同一 pane 尺寸随来回切换发生抖动会被记录为 flips', () => {
  const snaps = buildScenario()
  const flips = paneFlips(snaps, '%1')
  assert.ok(flips.length >= 2, 'pane 尺寸序列应有多次变化')
  // 每次 select 被抢再拉回 → flips 次数 ≈ 10 * 2
  assert.ok(flips.length >= 10, `expected >=10 flips, got ${flips.length}`)
})

test('S-repro: 稳定单 client 无 drift 基线', () => {
  const stable: Snap[] = [
    {
      xterm: { cols: 120, rows: 36 },
      win: { w: 120, h: 36 },
      panes: [
        { paneId: '%1', w: 60, h: 18, active: true },
        { paneId: '%2', w: 60, h: 18, active: false },
      ],
    },
  ]
  assert.equal(stable.filter(driftOf).length, 0)
})
