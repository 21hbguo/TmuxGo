import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PANE_DRAG_MIME,
  buildPaneDropRegions,
  directionForPaneDropSide,
  endPaneDrag,
  getPaneDrag,
  isPaneDrag,
  readPaneDragPayload,
  resetPaneDrag,
  resolvePaneDropSide,
  startPaneDrag,
  subscribePaneDrag,
} from './pane-drag'

function createDataTransfer(payload: Record<string, string>) {
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    types: Object.keys(payload),
    setData: vi.fn(),
    getData: (type: string) => payload[type] || '',
  } as unknown as DataTransfer
}

function pane(
  overrides: Partial<{
    id: string
    title: string
    index: number
    left: number
    top: number
    cols: number
    rows: number
  }>,
) {
  const { id = 'local:%1', title, index, left = 0, top = 0, cols = 80, rows = 24 } = overrides
  return { id, title, index, left, top, size: { cols, rows } }
}

describe('resolvePaneDropSide', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 }
  it('picks the horizontal half for points near the left/right edges', () => {
    expect(resolvePaneDropSide(rect, 120, 100)).toBe('left')
    expect(resolvePaneDropSide(rect, 280, 100)).toBe('right')
  })
  it('picks the vertical half for points near the top/bottom edges', () => {
    expect(resolvePaneDropSide(rect, 200, 55)).toBe('top')
    expect(resolvePaneDropSide(rect, 200, 145)).toBe('bottom')
  })
  it('clamps points outside the rect and breaks ties horizontally', () => {
    expect(resolvePaneDropSide(rect, 0, 0)).toBe('left')
    // 右下角平局（两个方向同样远）归水平，与「正中线也归水平」保持一致
    expect(resolvePaneDropSide(rect, 999, 999)).toBe('right')
  })
})

describe('directionForPaneDropSide', () => {
  it('maps left/right to horizontal and top/bottom to vertical', () => {
    expect(directionForPaneDropSide('left')).toBe('horizontal')
    expect(directionForPaneDropSide('right')).toBe('horizontal')
    expect(directionForPaneDropSide('top')).toBe('vertical')
    expect(directionForPaneDropSide('bottom')).toBe('vertical')
  })
})

describe('buildPaneDropRegions', () => {
  it('normalises tmux pixel geometry into 0..1 drop rects', () => {
    const regions = buildPaneDropRegions([
      pane({ id: 'local:%1', title: 'left', index: 0, left: 0, top: 0, cols: 80, rows: 24 }),
      pane({ id: 'local:%2', title: 'right', index: 1, left: 80, top: 0, cols: 80, rows: 24 }),
    ])
    expect(regions).toHaveLength(2)
    expect(regions[0]).toMatchObject({
      paneId: 'local:%1',
      title: 'left',
      rect: { left: 0, top: 0, width: 0.5, height: 1 },
    })
    expect(regions[1].rect).toMatchObject({ left: 0.5, width: 0.5 })
  })
  it('returns nothing when geometry is missing so no invisible zones are painted', () => {
    expect(buildPaneDropRegions([])).toEqual([])
    expect(buildPaneDropRegions([{ id: 'local:%1', title: 'shell', left: 0, top: 0 }])).toEqual([])
  })
})

describe('pane drag store', () => {
  beforeEach(() => {
    resetPaneDrag()
  })
  it('notifies subscribers and clears only for the matching pane id', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePaneDrag(listener)
    startPaneDrag({ paneId: 'local:%1', windowId: 'local:@1', title: 'shell' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getPaneDrag()).toMatchObject({ paneId: 'local:%1' })
    // 别的 pane 的 dragend 不能把进行中的拖拽清掉
    endPaneDrag('local:%9')
    expect(getPaneDrag()).not.toBeNull()
    endPaneDrag('local:%1')
    expect(getPaneDrag()).toBeNull()
    unsubscribe()
  })
  it('detects a pane drag from types even before the store is set', () => {
    expect(isPaneDrag(createDataTransfer({ [PANE_DRAG_MIME]: '{}' }))).toBe(true)
    expect(isPaneDrag(createDataTransfer({ 'text/plain': 'x' }))).toBe(false)
  })
  it('reads the payload from dataTransfer first and falls back to the store', () => {
    startPaneDrag({ paneId: 'local:%1', windowId: 'local:@1' })
    expect(
      readPaneDragPayload(createDataTransfer({ [PANE_DRAG_MIME]: JSON.stringify({ paneId: 'local:%2' }) })),
    ).toEqual({
      paneId: 'local:%2',
      windowId: undefined,
      title: undefined,
    })
    expect(readPaneDragPayload(createDataTransfer({}))).toEqual({ paneId: 'local:%1', windowId: 'local:@1' })
    expect(readPaneDragPayload(createDataTransfer({ [PANE_DRAG_MIME]: 'local:%7' }))).toEqual({ paneId: 'local:%7' })
  })
})
