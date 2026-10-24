import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildPaneTargets, buildWindowTargets, PaneNumberOverlay } from './PaneNumberOverlay'
import type { Pane, Window } from '@/types'

// 用真 zh 词表断言提示文案
vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')
  return {
    useTranslation: () => ({
      language: 'zh',
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
    }),
  }
})

const pane = (over: Partial<Pane> & Pick<Pane, 'id'>): Pane =>
  ({
    windowId: 'local:@1',
    index: 0,
    title: '',
    active: false,
    left: 0,
    top: 0,
    size: { cols: 80, rows: 24 },
    ...over,
  }) as Pane

describe('buildPaneTargets', () => {
  it('normalises tmux cell geometry into window-relative fractions', () => {
    const targets = buildPaneTargets([
      pane({ id: 'local:%1', index: 0, left: 0, top: 0, size: { cols: 80, rows: 24 } }),
      pane({ id: 'local:%2', index: 1, left: 80, top: 0, size: { cols: 80, rows: 24 } }),
    ])
    expect(targets.map((item) => item.number)).toEqual([1, 2])
    // 左右各半：右 pane 从 50% 开始
    expect(targets[1]!.rect).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 })
  })

  it('numbers panes 1..n by order, not pane.index + 1 (pane-base-index 1 会整体错位一格)', () => {
    const targets = buildPaneTargets([
      pane({ id: 'local:%1', index: 1, top: 0 }),
      pane({ id: 'local:%3', index: 3, top: 24, title: 'logs' }),
    ])
    expect(targets.map((item) => item.number)).toEqual([1, 2])
    expect(targets.map((item) => item.label)).toEqual(['#1', 'logs'])
    // 默认 0 起（pane-base-index 0）时行为不变
    expect(
      buildPaneTargets([pane({ id: 'local:%1', index: 0 }), pane({ id: 'local:%2', index: 1, top: 24 })]).map(
        (item) => item.number,
      ),
    ).toEqual([1, 2])
  })

  it('lays window badges out in one row instead of stacking them on the same spot', () => {
    render(
      <PaneNumberOverlay
        mode="windows"
        targets={[
          { id: 'local:@1', number: 1, label: 'dev' },
          { id: 'local:@2', number: 2, label: 'ops' },
        ]}
      />,
    )
    const first = screen.getByTestId('window-number-1')
    const second = screen.getByTestId('window-number-2')
    // 同一个横向容器里做兄弟节点，才会并排；旧实现各自 absolute inset-x-0 top-3 会完全重叠
    expect(first.parentElement).toBe(second.parentElement)
    expect(first.parentElement?.className).toContain('flex')
    expect(first.className).not.toContain('absolute')
  })

  it('bails out when there is nothing to jump to', () => {
    expect(buildPaneTargets([pane({ id: 'local:%1' })])).toEqual([])
    expect(buildPaneTargets([])).toEqual([])
    // 几何缺失（cols/rows 全 0）时不画出重叠的编号
    expect(
      buildPaneTargets([
        pane({ id: 'local:%1', size: { cols: 0, rows: 0 } }),
        pane({ id: 'local:%2', index: 1, size: { cols: 0, rows: 0 } }),
      ]),
    ).toEqual([])
  })
})

describe('buildWindowTargets', () => {
  it('numbers windows 1..n in tab order', () => {
    const windows = [
      { id: 'local:@1', name: 'dev' },
      { id: 'local:@2', name: 'ops' },
    ] as Window[]
    expect(buildWindowTargets(windows)).toEqual([
      { id: 'local:@1', number: 1, label: 'dev' },
      { id: 'local:@2', number: 2, label: 'ops' },
    ])
  })

  it('bails out with a single window', () => {
    expect(buildWindowTargets([{ id: 'local:@1', name: 'dev' } as Window])).toEqual([])
  })
})

describe('PaneNumberOverlay', () => {
  const targets = [
    { id: 'local:%1', number: 1, label: 'left', rect: { left: 0, top: 0, width: 0.5, height: 1 } },
    { id: 'local:%2', number: 2, label: 'right', rect: { left: 0.5, top: 0, width: 0.5, height: 1 } },
  ]

  it('draws one badge per pane at its relative position, without eating pointer events', () => {
    render(<PaneNumberOverlay mode="panes" targets={targets} />)
    const overlay = screen.getByTestId('pane-number-overlay')
    expect(overlay.dataset.mode).toBe('panes')
    expect(overlay.className).toContain('pointer-events-none')
    expect(screen.getByTestId('pane-number-1').textContent).toContain('1')
    expect(screen.getByTestId('pane-number-2').textContent).toContain('right')
    // 位置按比例落到 style 上，和 tmux 自己画的布局对齐
    expect(screen.getByTestId('pane-number-2').style.left).toBe('50%')
    expect(screen.getByTestId('pane-number-2').style.width).toBe('50%')
    expect(screen.getByTestId('pane-number-hint').textContent).toBe('按数字跳到 pane · Esc 取消')
  })

  it('renders window-level badges in zoom fallback mode', () => {
    render(
      <PaneNumberOverlay
        mode="windows"
        targets={[
          { id: 'local:@1', number: 1, label: 'dev' },
          { id: 'local:@2', number: 2, label: 'ops' },
        ]}
      />,
    )
    expect(screen.getByTestId('pane-number-overlay').dataset.mode).toBe('windows')
    expect(screen.getByTestId('window-number-1').textContent).toContain('dev')
    expect(screen.getByTestId('pane-number-hint').textContent).toBe('按数字跳到 window · Esc 取消')
  })

  it('renders nothing for an empty target list', () => {
    render(<PaneNumberOverlay mode="panes" targets={[]} />)
    expect(screen.queryByTestId('pane-number-overlay')).toBeNull()
  })
})
