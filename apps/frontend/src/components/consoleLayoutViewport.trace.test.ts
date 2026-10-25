import { describe, expect, it } from 'vitest'
import {
  collapseTraceFixture,
  compositionTraceFixture,
  normalCycleTraceFixture,
  viewportTraceFixtures,
  type ViewportTraceFixture,
} from './__fixtures__/viewportTraceFixtures'
import {
  appliedHeights,
  duplicateSteps,
  replayViewportTrace,
  withSteps,
  type ReplayFrame,
} from './__fixtures__/viewportTraceReplay'

const replay = (fixture: ViewportTraceFixture) => replayViewportTrace(fixture)

describe('viewport trace replay (characterization)', () => {
  it('pins the current 124px collapse: vv shrinks, flag lands late, baseline latches the applied height', () => {
    const frames = replay(collapseTraceFixture)
    // Current output, not desired output. 124 = applied closed height 446 minus
    // keyboard inset 322, because the open branch took the *applied* appHeight as
    // its closed baseline (`openingHeight = currentAppHeight`).
    expect(appliedHeights(frames)).toEqual(collapseTraceFixture.recordedAppHeights)
    expect(frames[1].appliedHeight).toBe(446)
    expect(frames[2].appliedHeight).toBe(124)
    expect(frames[2].layoutBaseHeight).toBe(446)
    // The 769 baseline is gone for good: even after the keyboard closes, the shell
    // stays at 446 and the next open collapses to 124 again.
    expect(frames[3].appliedHeight).toBe(446)
    expect(frames[5].appliedHeight).toBe(446)
    expect(frames[3].stableClosedHeight).toBe(446)
  })

  it('replays the healthy open/close cycle unchanged', () => {
    const frames = replay(normalCycleTraceFixture)
    expect(appliedHeights(frames)).toEqual(normalCycleTraceFixture.recordedAppHeights)
    // Open subtracts the occlusion once from the untouched 769 baseline.
    expect(frames[2]).toMatchObject({ appliedHeight: 446, open: true, layoutBaseHeight: 769 })
    // Close returns to the full baseline instead of the shrunken height.
    expect(frames[3]).toMatchObject({ appliedHeight: 769, open: false, stableClosedHeight: 769 })
  })

  it('keeps the shell and the baseline untouched while composing', () => {
    const frames = replay(compositionTraceFixture)
    expect(appliedHeights(frames)).toEqual(compositionTraceFixture.recordedAppHeights)
    expect(frames.slice(3).every((frame) => !frame.applied)).toBe(true)
    expect(frames[4].stableClosedHeight).toBe(769)
    expect(frames[4].layoutBaseHeight).toBe(769)
  })

  it('keeps every fixture internally consistent with its recorded heights', () => {
    for (const fixture of viewportTraceFixtures)
      expect(appliedHeights(replay(fixture)), fixture.name).toEqual(fixture.recordedAppHeights)
  })

  // 夹紧是事故链的前置条件：没有「关闭态夹到可见高度」，appHeight 不会被压成 446，
  // 也就没有 124。这条同时把 harness 的 closedClamp 建模钉住，防止假设悄悄漂移。
  it('shows the collapse needs the closed-frame clamp before the flag lands', () => {
    const unclamped = replayViewportTrace(collapseTraceFixture, { closedClamp: false })
    expect(appliedHeights(unclamped)).toEqual([769, 769, 446, 769, 446, 769])
  })
})

describe('viewport contract invariants', () => {
  it('converges to the same terminal state under repeated notifications', () => {
    const single = replay(collapseTraceFixture)
    const repeated = replayViewportTrace(withSteps(duplicateSteps(collapseTraceFixture.steps), true))
    // 终态对比忽略 applied 标志（重复通知自然会被去重），只比状态与几何。
    const terminal = (frames: ReplayFrame[]) => {
      const { applied: _applied, ...rest } = frames[frames.length - 1]
      return rest
    }
    expect(terminal(repeated)).toEqual(terminal(single))

    const noisy = replayViewportTrace(
      withSteps(
        collapseTraceFixture.steps.flatMap((step, index) => (index === 1 ? [step, step, step] : [step])),
        true,
      ),
    )
    expect(terminal(noisy)).toEqual(terminal(single))
  })

  it('deducts one occlusion only once per open cycle', () => {
    const frames = replay(collapseTraceFixture)
    const open = frames.filter((frame) => frame.open)
    expect(open.length).toBeGreaterThan(1)
    // applied = base - inset, once; repeated open samples must not shrink further.
    for (const frame of open) expect(frame.appliedHeight).toBe(Math.round(frame.layoutBaseHeight - frame.inset))
    expect(new Set(open.map((frame) => frame.appliedHeight))).toEqual(new Set([124]))

    const healthy = replay(normalCycleTraceFixture).filter((frame) => frame.open)
    for (const frame of healthy) expect(frame.appliedHeight).toBe(Math.round(frame.layoutBaseHeight - frame.inset))
  })

  // Invariant 1 of viewportContract.ts: an applied appHeight must never become the
  // closed baseline. Today it does: the clamped closed frame applies 446, the open
  // frame takes 446 as `openingHeight`, and the shell collapses to 124 instead of
  // staying at the 769 full-layout baseline.
  it.fails('never feeds the applied appHeight back in as the closed baseline', () => {
    const frames = replay(collapseTraceFixture)
    expect(frames[2].stableClosedHeight).toBe(769)
    expect(frames[2].appliedHeight).toBe(446)
  })
})
