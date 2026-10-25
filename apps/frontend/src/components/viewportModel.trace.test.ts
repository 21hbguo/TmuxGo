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
  observationFromStep,
  replayDual,
  replayViewportModel,
} from './__fixtures__/viewportTraceReplay'

const modelHeights = (fixture: ViewportTraceFixture) => replayViewportModel(fixture).map((frame) => frame.visibleHeight)

// 事故值：旧机器在「vv 先缩、flag 后落位」时算出的壳高。
const COLLAPSE_HEIGHT = 124

describe('new model replay on the recorded traces', () => {
  it('never reproduces the 124px collapse on the trace that produced it', () => {
    const dual = replayDual(collapseTraceFixture)
    const legacy = appliedHeights(dual.map((frame) => frame.legacy))
    const model = dual.map((frame) => frame.model.visibleHeight)
    // 旧机器逐帧复现事故（含两次 124）
    expect(legacy).toEqual(collapseTraceFixture.recordedAppHeights)
    expect(legacy.filter((height) => height === COLLAPSE_HEIGHT)).toHaveLength(2)
    // 新模型：跟随可见视口，全程没有 124，且没有低于半屏的值
    expect(model).toEqual([769, 446, 446, 769, 446, 769])
    expect(model).not.toContain(COLLAPSE_HEIGHT)
    for (const height of model) expect(height).toBeGreaterThan(400)
    // 旧机器崩到 124 的两帧，新模型给的就是 446
    for (const index of [2, 4]) expect(dual[index].model.visibleHeight).toBe(446)
  })

  it('keeps the closed baseline while the shell follows the occlusion', () => {
    const frames = replayViewportModel(collapseTraceFixture)
    // 收缩帧：可见区已经跟着 vv 走，但 full-layout 基线还在。
    // 新模型的基线是 layout viewport（innerHeight 768，整屏），不是 vv 的 768.56
    // —— 旧机器取的是 vv 值，所以旧轨迹里基线和壳高都是 769。
    expect(frames[1]).toMatchObject({ visibleHeight: 446, fullLayoutHeight: 768 })
    // 纯推断（无 vk 几何）时首帧只到 opening，要等一次 settle；而这段真机轨迹每次开键
    // 只记了一帧，所以重放里两轮都停在 opening —— 生产靠模型自己排的重采样补齐，
    // 见下面的 nextWakeAt 断言。轨迹稀疏是采样的局限，不是模型没收敛。
    expect(frames[2]).toMatchObject({ visibleHeight: 446, phase: 'opening' })
    expect(frames[4]).toMatchObject({ visibleHeight: 446, phase: 'opening' })
    for (const index of [2, 4]) expect(frames[index].nextWakeAt).not.toBeNull()
    // 第二次收缩不再重复扣一次遮挡
    expect(frames[4].visibleHeight).toBe(446)
    expect(frames[4].occlusionHeight).toBe(322)
    expect(frames[3].visibleHeight).toBe(769)
  })

  it('classifies the shrink as expected policy difference on the healthy cycle', () => {
    const dual = replayDual(normalCycleTraceFixture)
    expect(appliedHeights(dual.map((frame) => frame.legacy))).toEqual(normalCycleTraceFixture.recordedAppHeights)
    // 旧机器 36/48px 滞回 + 大收缩保护：收缩帧仍按 769 施加；
    // 新模型逐帧跟随可见区（这就是 V7 的设计差异，不是缺陷）。
    expect(dual.map((frame) => frame.legacy.appliedHeight)).toEqual([769, 769, 446, 769])
    expect(dual.map((frame) => frame.model.visibleHeight)).toEqual([769, 446, 446, 769])
    // 开键盘那帧两者一致，说明差异只在「何时跟随」，不在「跟随到哪」
    expect(dual[2].legacy.appliedHeight).toBe(dual[2].model.visibleHeight)
  })

  it('holds the applied shell while composing but still advances the model', () => {
    const frames = replayViewportModel(compositionTraceFixture)
    expect(frames.map((frame) => frame.visibleHeight)).toEqual([769, 459, 459, 459, 459])
    // composition 期间不写壳：applied 保持在开键后的 459
    expect(frames.slice(3).every((frame) => frame.appliedHeight === 459)).toBe(true)
    expect(frames.slice(3).some((frame) => frame.applied)).toBe(false)
  })

  it('stays below the legacy collapse on every fixture', () => {
    for (const fixture of viewportTraceFixtures) {
      const model = modelHeights(fixture)
      expect(model, fixture.name).not.toContain(COLLAPSE_HEIGHT)
      for (const height of model) expect(height, fixture.name).toBeGreaterThan(0)
    }
  })
})

describe('observation reconstruction from a trace step', () => {
  it('derives the documented approximations instead of inventing measurements', () => {
    const observation = observationFromStep(collapseTraceFixture.steps[2], 0)
    expect(observation).toMatchObject({
      layoutViewport: { width: 365, height: 768 },
      visualViewport: { height: 446.2757263183594, offsetTop: 0, offsetLeft: 0, scale: 1 },
      virtualKeyboard: { available: false, overlaysContent: false, rect: null },
      inputOwner: 'terminal',
      keyboardIntent: true,
      composition: false,
      orientation: 'portrait',
      fullscreen: false,
      envGen: 0,
    })
    // 关闭态样本没有键盘意图
    expect(observationFromStep(collapseTraceFixture.steps[1], 0)).toMatchObject({
      inputOwner: 'none',
      keyboardIntent: false,
    })
    // IME 样本带 composition 标记
    expect(observationFromStep(compositionTraceFixture.steps[3], 0).composition).toBe(true)
  })

  it('voids the baseline when the environment generation changes mid-trace', () => {
    // 同一个 vv 高度，但在第 3 步换环境代次：基线必须作废重锚，不能沿用旧代次的 769
    const stableEnv = replayViewportModel(collapseTraceFixture, { envGen: () => 0 })
    const switchEnv = replayViewportModel(collapseTraceFixture, { envGen: (_step, index) => (index >= 2 ? 1 : 0) })
    expect(stableEnv[2].fullLayoutHeight).toBe(768)
    expect(switchEnv[2].fullLayoutHeight).toBeNull()
    // 代次切换后可见区仍然跟随几何（不会把 124 式污染带过来）
    expect(switchEnv[2].visibleHeight).toBe(446)
  })
})
