'use client'

import { useTranslation } from '@/i18n'
import type { Pane, Window } from '@/types'

// display-panes 编号层（tmux <prefix>q 的桌面版）：在当前 window 上叠一层大号数字，
// 敲数字直接跳到对应 pane。纯前端：pane 几何来自 snapshot 的 pane_left/pane_top/
// pane_width/pane_height（tmux 会把 window 布局画在自己那格终端里，所以按比例盖上去正好对齐）。
export interface NumberTarget {
  id: string
  /** 显示的数字（沿用 tmux pane_index+1 / window 序号，保证和终端里看到的一致） */
  number: number
  label: string
  /** 相对 window 的比例矩形；window 级退化时不带，走等宽槽位 */
  rect?: { left: number; top: number; width: number; height: number }
}

export type DisplayPanesMode = 'panes' | 'windows'

/**
 * pane 级编号：几何按 window 总格数归一化。
 * 空 window（或只有一个 pane，没得跳）返回空数组，由调用方退化。
 */
export function buildPaneTargets(panes: Pane[]): NumberTarget[] {
  if (panes.length < 2) return []
  const cols = Math.max(...panes.map((pane) => (pane.left || 0) + (pane.size?.cols || 0)))
  const rows = Math.max(...panes.map((pane) => (pane.top || 0) + (pane.size?.rows || 0)))
  if (!cols || !rows) return []
  return [...panes]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((pane) => ({
      id: pane.id,
      number: (pane.index ?? 0) + 1,
      label: pane.title || `#${(pane.index ?? 0) + 1}`,
      rect: {
        left: (pane.left || 0) / cols,
        top: (pane.top || 0) / rows,
        width: (pane.size?.cols || 0) / cols,
        height: (pane.size?.rows || 0) / rows,
      },
    }))
}

/**
 * window 级编号：zoom 态（tmux -Z）只有一个 pane 铺满整屏，pane 几何指向的区域用户根本
 * 看不见，给 pane 编号会误导；按单里给的退化方案改成给 window 编号（跳 window）。
 */
export function buildWindowTargets(windows: Window[]): NumberTarget[] {
  if (windows.length < 2) return []
  return windows.map((window, i) => ({
    id: window.id,
    number: i + 1,
    label: window.name || `#${i + 1}`,
  }))
}

export function PaneNumberOverlay({ mode, targets }: { mode: DisplayPanesMode; targets: NumberTarget[] }) {
  const { t } = useTranslation()
  if (!targets.length) return null
  return (
    <div
      data-testid="pane-number-overlay"
      data-mode={mode}
      // 非交互层：不拦指针，点击交给上层的“点一下取消”监听
      className="pointer-events-none absolute inset-0 z-30 select-none"
    >
      {mode === 'panes'
        ? targets.map((target) => (
            <div
              key={target.id}
              data-testid={`pane-number-${target.number}`}
              style={{
                left: `${(target.rect?.left ?? 0) * 100}%`,
                top: `${(target.rect?.top ?? 0) * 100}%`,
                width: `${(target.rect?.width ?? 1) * 100}%`,
                height: `${(target.rect?.height ?? 1) * 100}%`,
              }}
              className="absolute flex items-center justify-center"
            >
              <span className="flex items-center gap-2 rounded-apple-lg bg-black/75 px-[max(0.5rem,1.2vmin)] py-[max(0.25rem,0.6vmin)] shadow-lg">
                <span className="text-[clamp(16px,3vmin,34px)] font-semibold leading-none text-accent">
                  {target.number}
                </span>
                <span className="max-w-[16ch] truncate text-[clamp(9px,1.2vmin,13px)] leading-none text-white/70">
                  {target.label}
                </span>
              </span>
            </div>
          ))
        : targets.map((target) => (
            <div
              key={target.id}
              data-testid={`window-number-${target.number}`}
              className="absolute inset-x-0 top-3 flex justify-center"
            >
              <span className="flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 shadow-lg">
                <span className="text-base font-semibold leading-none text-accent">{target.number}</span>
                <span className="max-w-[18ch] truncate text-xs leading-none text-white/75">{target.label}</span>
              </span>
            </div>
          ))}
      <div className="absolute inset-x-0 bottom-3 flex justify-center">
        <span data-testid="pane-number-hint" className="rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/70">
          {t(mode === 'panes' ? 'displayPanes.hint' : 'displayPanes.hintWindows')}
        </span>
      </div>
    </div>
  )
}
