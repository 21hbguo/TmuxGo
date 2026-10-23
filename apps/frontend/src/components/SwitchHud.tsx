'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n'

// 横滑切换后的方位提示：手机上没有完整布局可视，滑完会「不知道切到哪、还能往哪滑」。
// 只做一次性闪现（非交互、不吃手势），连续切换时重置计时而不是叠加多层。
export const SWITCH_HUD_DURATION_MS = 1300

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

// payload 每次切换都是新对象：effect 依赖它即可在连续切换时重置计时
export function SwitchHud({ payload }: { payload: SwitchHudPayload | null }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!payload) return
    setVisible(true)
    // 连续切换：上一次的计时由 effect cleanup 清掉，这里只装新计时，不叠加
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setVisible(false)
    }, SWITCH_HUD_DURATION_MS)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [payload])

  useEffect(() => () => setVisible(false), [])

  if (!payload || !visible) return null

  return (
    <div
      data-testid="switch-hud"
      // 手势要继续可用：整层 pointer-events-none，且不参与布局（absolute）
      className="pointer-events-none absolute inset-x-0 bottom-16 z-30 flex justify-center px-4"
    >
      <div className="tmuxgo-switch-hud flex items-center gap-3 rounded-apple-lg bg-black/70 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-sm">
        {payload.prevLabel ? (
          <span data-testid="switch-hud-prev" className="max-w-[28vw] truncate text-white/65">
            {t('switchHud.prev', { label: payload.prevLabel })}
          </span>
        ) : (
          <span className="w-3" />
        )}
        <span className="flex flex-col items-center leading-tight">
          <span data-testid="switch-hud-position" className="font-medium">
            {t('switchHud.windowPosition', { index: payload.windowIndex, total: payload.windowTotal })}
            <span className="text-white/70"> · {payload.windowName}</span>
          </span>
          {payload.paneIndex !== undefined && payload.paneTotal !== undefined && (
            <span data-testid="switch-hud-pane" className="text-[11px] text-accent">
              {t('switchHud.panePosition', { index: payload.paneIndex, total: payload.paneTotal })}
            </span>
          )}
        </span>
        {payload.nextLabel ? (
          <span data-testid="switch-hud-next" className="max-w-[28vw] truncate text-white/65">
            {t('switchHud.next', { label: payload.nextLabel })}
          </span>
        ) : (
          <span className="w-3" />
        )}
      </div>
    </div>
  )
}
