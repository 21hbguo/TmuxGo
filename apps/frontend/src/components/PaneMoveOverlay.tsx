'use client'
import { useState } from 'react'
import { useTranslation } from '@/i18n'
import { cn } from '@/lib/cn'
import {
  buildPaneDropRegions,
  directionForPaneDropSide,
  endPaneDrag,
  isPaneDrag,
  readPaneDragPayload,
  resolvePaneDropSide,
  type PaneDropSide,
  type PaneMoveDirection,
} from '@/lib/pane-drag'
import type { Pane } from '@/types'

// 落点半边的高亮块：整块铺在那半边，让「会从哪里插进去」一眼可见
const HINT_CLASS: Record<PaneDropSide, string> = {
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2',
}

/**
 * pane 拖拽的几何落点层：拖起 pane 后，把当前 window 里每个 pane 按 tmux 给的
 * 像素几何盖成一块透明区域（与 PaneNumberOverlay 同一口径），指针落在哪半边就
 * 高亮哪半边，松手按「左右=horizontal、上下=vertical」调 move。
 *
 * 只画覆盖层，不改布局：终端尺寸由 PaneGrid/RO 管，插一个流内元素会让 cols/rows 抖一下。
 */
export function PaneMoveOverlay({
  panes,
  dragPaneId,
  onMove,
}: {
  /** 当前 window 的 pane（含被拖起的那个，内部会排除） */
  panes: Pane[]
  dragPaneId: string
  onMove: (paneId: string, targetPaneId: string, direction: PaneMoveDirection) => void
}) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<{ paneId: string; side: PaneDropSide } | null>(null)
  const regions = buildPaneDropRegions(panes).filter((region) => region.paneId !== dragPaneId)
  if (regions.length === 0) return null
  const clearHover = (paneId: string) => setHover((current) => (current?.paneId === paneId ? null : current))
  return (
    <div data-testid="pane-move-overlay" className="pointer-events-none absolute inset-0 z-30">
      {regions.map((region) => {
        const side = hover?.paneId === region.paneId ? hover.side : null
        return (
          <div
            key={region.paneId}
            data-testid={`pane-drop-${region.paneId}`}
            data-active-side={side ?? undefined}
            className={cn(
              'pointer-events-auto absolute rounded-sm border border-dashed transition-colors',
              side ? 'border-accent bg-accent/10' : 'border-accent/35 bg-accent/[0.04]',
            )}
            style={{
              left: `${region.rect.left * 100}%`,
              top: `${region.rect.top * 100}%`,
              width: `${region.rect.width * 100}%`,
              height: `${region.rect.height * 100}%`,
            }}
            onDragOver={(event) => {
              if (!isPaneDrag(event.dataTransfer)) return
              // preventDefault 才允许 drop；stopPropagation 防止外层停靠 zones 抢这条手势
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              const rect = event.currentTarget.getBoundingClientRect()
              const next = resolvePaneDropSide(rect, event.clientX, event.clientY)
              setHover((current) =>
                current?.paneId === region.paneId && current.side === next
                  ? current
                  : { paneId: region.paneId, side: next },
              )
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearHover(region.paneId)
            }}
            onDrop={(event) => {
              if (!isPaneDrag(event.dataTransfer)) return
              event.preventDefault()
              event.stopPropagation()
              const payload = readPaneDragPayload(event.dataTransfer)
              clearHover(region.paneId)
              if (!payload || payload.paneId === region.paneId) return
              const rect = event.currentTarget.getBoundingClientRect()
              const next = resolvePaneDropSide(rect, event.clientX, event.clientY)
              endPaneDrag(payload.paneId)
              onMove(payload.paneId, region.paneId, directionForPaneDropSide(next))
            }}
          >
            <span className="pointer-events-none absolute left-1 top-1 max-w-[calc(100%-0.5rem)] truncate rounded border border-[var(--line)] bg-bg-0/85 px-1 py-0.5 text-caption text-text-3">
              {region.title}
            </span>
            {side && (
              <span
                data-testid={`pane-drop-hint-${region.paneId}`}
                data-side={side}
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute bg-accent/25 ring-1 ring-inset ring-accent/70',
                  HINT_CLASS[side],
                )}
              />
            )}
          </div>
        )
      })}
      <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center">
        <span className="rounded-full border border-[var(--line)] bg-bg-0/85 px-2 py-0.5 text-caption text-text-3">
          {t('pane.dropHint')}
        </span>
      </div>
    </div>
  )
}
