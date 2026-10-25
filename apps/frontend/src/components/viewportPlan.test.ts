import { describe, expect, it } from 'vitest'
import type { ViewportSnapshot } from './viewportContract'
import { computeLayoutPlan, type LayoutPlanInput } from './viewportPlan'

// 几何基线：390x800 的 pane、10x20 的 cell → 39 列 40 行；dock 56px
const snapshot = (overrides: Partial<ViewportSnapshot> = {}): ViewportSnapshot => ({
  fullLayoutSpace: { width: 390, height: 800 },
  visibleRegion: { width: 390, height: 800, offsetTop: 0 },
  occlusion: { height: 0, trusted: true, source: 'none' },
  keyboardPhase: 'closed',
  envGen: 1,
  measuredAt: 0,
  ...overrides,
})

type InputOverrides = Partial<Omit<LayoutPlanInput, 'snapshot'>> & { snapshot?: ViewportSnapshot }

const input = (overrides: InputOverrides = {}): LayoutPlanInput => ({
  snapshot: snapshot(),
  pane: { width: 390, height: 800 },
  cell: { width: 10, height: 20 },
  currentGrid: { cols: 39, rows: 40 },
  ownership: 'exclusive',
  dockHeight: 56,
  version: 7,
  ...overrides,
})

// 键盘遮挡：视觉区域缩到 500，遮挡 300，容器尚未重排（仍是 800）
const keyboardOpen = (visibleHeight = 500, occlusionHeight = 300) =>
  snapshot({
    visibleRegion: { width: 390, height: visibleHeight, offsetTop: 0 },
    occlusion: { height: occlusionHeight, trusted: true, source: 'virtual-keyboard' },
    keyboardPhase: 'open',
  })

describe('computeLayoutPlan keep vs refit', () => {
  it('keeps the grid on pure keyboard height occlusion and clips from the bottom', () => {
    const plan = computeLayoutPlan(input({ snapshot: keyboardOpen() }))
    expect(plan.terminal.targetGrid).toBe('keep')
    // 画布 40*20=800，可见 500 → 上移 300（等于遮挡高度）
    expect(plan.terminal.clipTranslateY).toBe(300)
    expect(plan.terminal.visibleHeight).toBe(500)
    expect(plan.shell.height).toBe(500)
    expect(plan.requestRemoteResize).toBeNull()
  })

  it('keeps the grid with zero clip when geometry is unchanged', () => {
    const plan = computeLayoutPlan(input())
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.terminal.clipTranslateY).toBe(0)
    expect(plan.requestRemoteResize).toBeNull()
  })

  it('refits on width change (rotation)', () => {
    const plan = computeLayoutPlan(input({ pane: { width: 300, height: 800 } }))
    expect(plan.terminal.targetGrid).toEqual({ cols: 30, rows: 40 })
    expect(plan.terminal.clipTranslateY).toBe(0)
    expect(plan.requestRemoteResize).toEqual({ cols: 30, rows: 40 })
  })

  it('refits when the font cell grows', () => {
    const plan = computeLayoutPlan(input({ cell: { width: 12, height: 22 } }))
    expect(plan.terminal.targetGrid).toEqual({ cols: 32, rows: 36 })
    expect(plan.requestRemoteResize).toEqual({ cols: 32, rows: 36 })
  })

  it('refits on a real height change without occlusion (split view)', () => {
    const plan = computeLayoutPlan(
      input({
        snapshot: snapshot({ visibleRegion: { width: 390, height: 400, offsetTop: 0 } }),
        pane: { width: 390, height: 400 },
      }),
    )
    expect(plan.terminal.targetGrid).toEqual({ cols: 39, rows: 20 })
    expect(plan.requestRemoteResize).toEqual({ cols: 39, rows: 20 })
  })

  it('refits upward when more rows become available', () => {
    const plan = computeLayoutPlan(input({ currentGrid: { cols: 39, rows: 30 } }))
    expect(plan.terminal.targetGrid).toEqual({ cols: 39, rows: 40 })
    expect(plan.requestRemoteResize).toEqual({ cols: 39, rows: 40 })
  })

  it('refits when width changes together with occlusion', () => {
    const plan = computeLayoutPlan(input({ snapshot: keyboardOpen(), pane: { width: 300, height: 800 } }))
    expect(plan.terminal.targetGrid).toEqual({ cols: 30, rows: 25 })
    expect(plan.requestRemoteResize).toEqual({ cols: 30, rows: 25 })
  })
})

describe('computeLayoutPlan shared ownership', () => {
  it('keeps the grid and never requests a remote resize on occlusion', () => {
    const plan = computeLayoutPlan(input({ snapshot: keyboardOpen(), ownership: 'shared' }))
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.terminal.clipTranslateY).toBe(300)
    expect(plan.requestRemoteResize).toBeNull()
  })

  it('keeps the grid and never requests a remote resize on width change', () => {
    const plan = computeLayoutPlan(input({ ownership: 'shared', pane: { width: 300, height: 800 } }))
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.requestRemoteResize).toBeNull()
  })

  it('keeps the shared grid on a real height change', () => {
    const plan = computeLayoutPlan(input({ ownership: 'shared', currentGrid: { cols: 80, rows: 24 } }))
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.requestRemoteResize).toBeNull()
  })
})

describe('clipTranslateY boundaries', () => {
  it('is zero when there is no occlusion', () => {
    expect(computeLayoutPlan(input()).terminal.clipTranslateY).toBe(0)
  })

  it('caps at the full canvas height when the visible height is zero', () => {
    const plan = computeLayoutPlan(
      input({ snapshot: snapshot({ visibleRegion: { width: 390, height: 0, offsetTop: 0 } }) }),
    )
    expect(plan.terminal.visibleHeight).toBe(0)
    expect(plan.terminal.clipTranslateY).toBe(800)
    expect(plan.terminal.targetGrid).toBe('keep')
  })

  it('clips by more than a full row when occlusion exceeds visible height', () => {
    const plan = computeLayoutPlan(input({ snapshot: keyboardOpen(100, 700), pane: { width: 390, height: 100 } }))
    expect(plan.terminal.visibleHeight).toBe(100)
    expect(plan.terminal.clipTranslateY).toBe(700)
  })

  it('keeps the clip sub-row exact when the visible height falls between rows', () => {
    const plan = computeLayoutPlan(input({ snapshot: keyboardOpen(390, 410) }))
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.terminal.clipTranslateY).toBe(410)
  })

  it('degrades to no clip without a valid cell height', () => {
    const plan = computeLayoutPlan(input({ cell: { width: 10, height: 0 } }))
    expect(plan.terminal.clipTranslateY).toBe(0)
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.requestRemoteResize).toBeNull()
  })
})

describe('remainder fill', () => {
  it('stretches the last row for a sub-row remainder', () => {
    const plan = computeLayoutPlan(
      input({
        snapshot: snapshot({ visibleRegion: { width: 390, height: 805, offsetTop: 0 } }),
        pane: { width: 390, height: 805 },
      }),
    )
    // 805/20 = 40 行，残差 5px < 1 行
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.terminal.remainderFill).toBe('last-row')
  })

  it('falls back to background when a full row or more is left over', () => {
    const plan = computeLayoutPlan(input({ ownership: 'shared', currentGrid: { cols: 39, rows: 30 } }))
    // 30*20=600 画布 vs 800 可见 → 余量 200 ≥ 1 行
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.terminal.remainderFill).toBe('background')
  })

  it('honours an explicit override', () => {
    expect(computeLayoutPlan(input({ remainderFill: 'background' })).terminal.remainderFill).toBe('background')
    expect(
      computeLayoutPlan(input({ ownership: 'shared', currentGrid: { cols: 39, rows: 30 }, remainderFill: 'last-row' }))
        .terminal.remainderFill,
    ).toBe('last-row')
  })
})

describe('requestRemoteResize', () => {
  it('is present only for exclusive owners with a real grid change', () => {
    expect(computeLayoutPlan(input()).requestRemoteResize).toBeNull()
    expect(computeLayoutPlan(input({ snapshot: keyboardOpen() })).requestRemoteResize).toBeNull()
    expect(computeLayoutPlan(input({ pane: { width: 300, height: 800 } })).requestRemoteResize).toEqual({
      cols: 30,
      rows: 40,
    })
    expect(
      computeLayoutPlan(input({ pane: { width: 300, height: 800 }, ownership: 'shared' })).requestRemoteResize,
    ).toBeNull()
  })
})

describe('dock', () => {
  it('stays visible without occlusion', () => {
    expect(computeLayoutPlan(input()).dock).toBe('visible')
  })

  it('is covered when the occlusion band reaches the dock', () => {
    expect(computeLayoutPlan(input({ snapshot: keyboardOpen() })).dock).toBe('covered')
  })

  it('is visible when there is no dock or no occlusion source', () => {
    expect(computeLayoutPlan(input({ snapshot: keyboardOpen(), dockHeight: 0 })).dock).toBe('visible')
    expect(
      computeLayoutPlan(input({ snapshot: snapshot({ occlusion: { height: 300, trusted: true, source: 'none' } }) }))
        .dock,
    ).toBe('visible')
  })
})

describe('scrollAnchor and purity', () => {
  it('anchors to bottom unless the user scrolled up', () => {
    expect(computeLayoutPlan(input()).terminal.scrollAnchor).toBe('bottom')
    expect(computeLayoutPlan(input({ scrollAtBottom: false })).terminal.scrollAnchor).toBe('keep')
  })

  it('passes the version through and leaves the input untouched', () => {
    const source = input({ snapshot: keyboardOpen() })
    const frozen = structuredClone(source)
    const plan = computeLayoutPlan(source)
    expect(plan.version).toBe(7)
    expect(source).toEqual(frozen)
    expect(computeLayoutPlan(source)).toEqual(plan)
  })

  it('survives NaN geometry without throwing', () => {
    const plan = computeLayoutPlan(
      input({ pane: { width: Number.NaN, height: Number.NaN }, cell: { width: Number.NaN, height: Number.NaN } }),
    )
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.terminal.clipTranslateY).toBe(0)
    expect(plan.shell.height).toBe(800)
  })
})

// --- F2 guards: causation evidence + degenerate pane geometry ---
describe('occlusion-only requires metric evidence', () => {
  it('refits instead of keeping when the cell grew under the keyboard', () => {
    // 同一形状（39 列、行数变少）但成因是字体行高变化：必须走真 refit
    const plan = computeLayoutPlan(
      input({
        snapshot: keyboardOpen(500, 300),
        cell: { width: 10, height: 25 },
        prevCell: { width: 10, height: 20 },
        currentGrid: { cols: 39, rows: 40 },
      }),
    )
    expect(plan.terminal.targetGrid).toEqual({ cols: 39, rows: 20 })
    expect(plan.requestRemoteResize).toEqual({ cols: 39, rows: 20 })
  })

  it('keeps the grid when the fingerprint proves the cell did not change', () => {
    const plan = computeLayoutPlan(input({ snapshot: keyboardOpen(500, 300), prevCell: { width: 10, height: 20 } }))
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.requestRemoteResize).toBeNull()
  })

  it('honours a cell generation change and ignores an unchanged one', () => {
    const changed = computeLayoutPlan(input({ snapshot: keyboardOpen(500, 300), cellGen: 4, prevCellGen: 3 }))
    expect(changed.terminal.targetGrid).toEqual({ cols: 39, rows: 25 })
    const same = computeLayoutPlan(input({ snapshot: keyboardOpen(500, 300), cellGen: 3, prevCellGen: 3 }))
    expect(same.terminal.targetGrid).toBe('keep')
  })

  it('still keeps pure occlusion when no fingerprint is available (migration default)', () => {
    const plan = computeLayoutPlan(input({ snapshot: keyboardOpen(500, 300) }))
    expect(plan.terminal.targetGrid).toBe('keep')
  })
})

describe('degenerate pane geometry', () => {
  it('never claims a remote resize for a zero-width pane with a valid cell', () => {
    const plan = computeLayoutPlan(input({ pane: { width: 0, height: 500 }, snapshot: keyboardOpen(500, 300) }))
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.requestRemoteResize).toBeNull()
    // 仍然裁剪到可见区，而不是把远端网格缩成 2 列
    expect(plan.terminal.clipTranslateY).toBe(300)
  })

  it('never refits a zero-width pane without occlusion either', () => {
    const plan = computeLayoutPlan(input({ pane: { width: 0, height: 800 } }))
    expect(plan.terminal.targetGrid).toBe('keep')
    expect(plan.requestRemoteResize).toBeNull()
  })

  it('keeps refitting normally once the width is measured again', () => {
    const plan = computeLayoutPlan(input({ pane: { width: 300, height: 800 } }))
    expect(plan.requestRemoteResize).toEqual({ cols: 30, rows: 40 })
  })
})
