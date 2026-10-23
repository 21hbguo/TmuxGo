'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n'

// 横滑切换后的方位提示：手机上没有完整布局可视，滑完会「不知道切到哪、还能往哪滑」。
// 只做一次性闪现（非交互、不吃手势），连续切换时重置计时而不是叠加多层。
export const SWITCH_HUD_DURATION_MS = 1300
// 段条上限：超过这么多目标，分段比文本更难读，退化成纯文本 n/total
export const SWITCH_HUD_MAX_SEGMENTS = 8
// 邻居名截断长度：10 字符后省略，避免窄屏把主行挤到换行
export const SWITCH_HUD_LABEL_LIMIT = 10

export interface SwitchHudPayload {
  /** 当前窗口序号（1 起） */
  windowIndex: number
  windowTotal: number
  windowName: string
  /** zoom 全屏态下的 pane 序号（1 起）；非 zoom / 单 pane 时不带 */
  paneIndex?: number
  paneTotal?: number
  /** 左侧邻居名（window 名或 pane title）；到头则 undefined */
  prevLabel?: string
  nextLabel?: string
}

const clipLabel = (label?: string) => {
  if (!label) return undefined
  return label.length > SWITCH_HUD_LABEL_LIMIT ? `${label.slice(0, SWITCH_HUD_LABEL_LIMIT)}…` : label
}

// 分段位置指示（■ ■ □ □）：当前段 accent 高亮且更长，其余为灰短刻度。
// tone 用主题变量而非写死色值，zoom 态 pane 条走 accent-2 与窗口条区分。
function SegmentBar({
  index,
  total,
  testId,
  tone,
  transition,
}: {
  index: number
  total: number
  testId: string
  tone: string
  transition: boolean
}) {
  if (total < 2 || total > SWITCH_HUD_MAX_SEGMENTS) return null
  return (
    <span data-testid={testId} data-total={total} className="flex shrink-0 items-center gap-[2px]">
      {Array.from({ length: total }, (_, i) => {
        const active = i === index - 1
        return (
          <span
            key={i}
            data-testid={active ? `${testId}-active` : undefined}
            className={`h-1 rounded-full ${active ? `w-4 ${tone}` : 'w-1 bg-white/25'} ${
              transition ? 'transition-all duration-150 ease-out' : ''
            }`}
          />
        )
      })}
    </span>
  )
}

// payload 每次切换都是新对象：effect 依赖它即可在连续切换时重置计时
export function SwitchHud({ payload }: { payload: SwitchHudPayload | null }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  // 进场：先以位移+透明挂载，下一帧切到终态，让 CSS transition 接管（不引动画库）
  const [entered, setEntered] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!payload) return
    setVisible(true)
    const raf = requestAnimationFrame(() => setEntered(true))
    // 连续切换：上一次的计时由 effect cleanup 清掉，这里只装新计时，不叠加
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setVisible(false)
      setEntered(false)
    }, SWITCH_HUD_DURATION_MS)
    return () => {
      cancelAnimationFrame(raf)
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [payload])

  useEffect(() => () => setVisible(false), [])

  if (!payload || !visible) return null

  const prev = clipLabel(payload.prevLabel)
  const next = clipLabel(payload.nextLabel)
  const hasPane = payload.paneIndex !== undefined && payload.paneTotal !== undefined

  return (
    <div
      data-testid="switch-hud"
      // 手势要继续可用：整层 pointer-events-none，且不参与布局（absolute）
      className="pointer-events-none absolute inset-x-0 bottom-16 z-30 flex justify-center px-4"
    >
      <div
        data-testid="switch-hud-card"
        className={`tmuxgo-switch-hud flex max-w-full items-center gap-3 rounded-apple-lg bg-black/70 px-3.5 py-2 text-xs text-white shadow-lg backdrop-blur-sm transition-all duration-150 ease-out ${
          entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
        }`}
      >
        {prev ? (
          <span
            data-testid="switch-hud-prev"
            className="min-w-0 max-w-[26vw] max-[360px]:max-w-[20vw] truncate tracking-wide text-white/60"
          >
            {t('switchHud.prev', { label: prev })}
          </span>
        ) : (
          <span className="w-2 shrink-0" />
        )}
        <span className="flex min-w-0 flex-col items-center gap-1 leading-tight">
          <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
            <SegmentBar
              index={payload.windowIndex}
              total={payload.windowTotal}
              testId="switch-hud-window-bar"
              tone="bg-accent"
              transition={entered}
            />
            <span data-testid="switch-hud-position" className="truncate font-medium tracking-wide">
              {t('switchHud.windowPosition', { index: payload.windowIndex, total: payload.windowTotal })}
              <span className="text-white/65"> · {payload.windowName}</span>
            </span>
          </span>
          {hasPane && (
            <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
              <SegmentBar
                index={payload.paneIndex!}
                total={payload.paneTotal!}
                testId="switch-hud-pane-bar"
                tone="bg-accent-2"
                transition={entered}
              />
              <span data-testid="switch-hud-pane" className="text-[11px] tracking-wide text-accent-2">
                {t('switchHud.panePosition', { index: payload.paneIndex!, total: payload.paneTotal! })}
              </span>
            </span>
          )}
        </span>
        {next ? (
          <span
            data-testid="switch-hud-next"
            className="min-w-0 max-w-[26vw] max-[360px]:max-w-[20vw] truncate tracking-wide text-white/60"
          >
            {t('switchHud.next', { label: next })}
          </span>
        ) : (
          <span className="w-2 shrink-0" />
        )}
      </div>
    </div>
  )
}
