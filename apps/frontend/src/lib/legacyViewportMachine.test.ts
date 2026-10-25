import { describe, expect, it } from 'vitest'
import { createLegacyViewportMachine, type LegacyViewportSample } from './legacyViewportMachine'

// F3 复审三步序列：vv 先缩、flag 后落位。固定 innerHeight=768。
const sample = (over: Partial<LegacyViewportSample> = {}): LegacyViewportSample => ({
  isMobileViewport: true,
  innerHeight: 768,
  viewportHeight: 768,
  viewportWidth: 390,
  keyboardOpen: false,
  bodyKeyboardOpen: false,
  keyboardInset: 0,
  immersive: false,
  now: 0,
  ...over,
})

describe('legacyViewportMachine', () => {
  it('keeps the 768 closed baseline when vv shrinks before the keyboard flag lands', () => {
    const machine = createLegacyViewportMachine(768)
    const closed = machine.step(sample({ now: 0 }))
    expect(closed).toMatchObject({ height: 768, closedBaseline: 768, open: false })

    // vv 缩到 446，flag 还没落位：旧机器不跟随大收缩
    const shrunk = machine.step(sample({ now: 100, viewportHeight: 446 }))
    expect(shrunk).toMatchObject({ height: 768, nextHeight: 768, held: true, closedBaseline: 768 })

    // flag 落位：从 768 扣一次 322，得到 446 —— 不是 124
    const open = machine.step(
      sample({ now: 200, viewportHeight: 446, keyboardOpen: true, bodyKeyboardOpen: true, keyboardInset: 322 }),
    )
    expect(open).toMatchObject({ height: 446, open: true })
    expect(open.closedBaseline).toBe(768)
    expect(machine.appliedHeight).toBe(446)

    // 关键盘：基线仍是 768，不是 446
    const close = machine.step(sample({ now: 300, viewportHeight: 446 }))
    expect(close).toMatchObject({ height: 768, closedBaseline: 768 })

    // 再开一次也不坍缩
    const reopen = machine.step(
      sample({ now: 400, viewportHeight: 446, keyboardOpen: true, bodyKeyboardOpen: true, keyboardInset: 322 }),
    )
    expect(reopen.height).toBe(446)
    expect([closed.height, shrunk.height, open.height, close.height, reopen.height]).not.toContain(124)
  })

  it('never consumes a height the caller applied on the model path', () => {
    const machine = createLegacyViewportMachine(768)
    machine.step(sample({ now: 0 }))
    // 模型在这里施加 446，但调用方不把它写回旧机器：只报告 height 出去
    const shrunk = machine.step(sample({ now: 100, viewportHeight: 446 }))
    expect(shrunk.height).toBe(768)
    const open = machine.step(
      sample({ now: 200, viewportHeight: 446, keyboardOpen: true, bodyKeyboardOpen: true, keyboardInset: 322 }),
    )
    expect(open.height).toBe(446)
    // 如果 446 被当成闭合基线，这里会是 124
    expect(open.height).not.toBe(124)
  })

  it('cold reset drops baseline, applied height and width history', () => {
    const machine = createLegacyViewportMachine(768)
    machine.step(sample({ now: 0 }))
    machine.step(sample({ now: 100, viewportHeight: 446 }))
    machine.reset()
    expect(machine.snapshot()).toMatchObject({ baseHeight: 0, appliedHeight: 0, viewportWidth: 0 })
    // 宽高都变了：下一 tick 从观测重新锚定，不带旧基线
    const reanchored = machine.step(sample({ now: 200, viewportHeight: 446 }))
    expect(reanchored).toMatchObject({ height: 446, closedBaseline: 446 })
  })

  it('defers the env reset so the current tick stays authoritative', () => {
    const machine = createLegacyViewportMachine(768)
    machine.step(sample({ now: 0 }))
    const shrunk = machine.step(sample({ now: 100, viewportHeight: 446 }))
    expect(machine.noteEnvGen(0)).toBe(false)
    expect(machine.noteEnvGen(0)).toBe(false)
    // 新 env：本 tick 结果仍是旧基线的（fallback 可能立刻施加它）
    const sameTick = machine.step(sample({ now: 200, viewportHeight: 446 }))
    expect(sameTick.height).toBe(768)
    expect(shrunk.height).toBe(768)
    expect(machine.noteEnvGen(1)).toBe(true)
    // 下一 tick 才冷启动：从观测重新锚定
    const afterReset = machine.step(sample({ now: 300, viewportHeight: 700 }))
    expect(afterReset).toMatchObject({ height: 700, closedBaseline: 700 })
  })

  it('holds sub-tolerance deltas instead of jittering the shell', () => {
    const machine = createLegacyViewportMachine(768)
    machine.step(sample({ now: 0 }))
    const tiny = machine.step(sample({ now: 100, viewportHeight: 740 }))
    expect(tiny).toMatchObject({ height: 768, held: true })
  })
})
