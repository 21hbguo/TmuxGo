'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { pushKeyLayer, popKeyLayer } from '@/lib/modal-layers'
import {
  buildPaneTargets,
  buildWindowTargets,
  type DisplayPanesMode,
  type NumberTarget,
} from '@/components/PaneNumberOverlay'
import type { Pane, Window } from '@/types'

// 编号层存活时长：tmux 原版 1-2s 只够看清，我们给到 4s（敲数字或任意键都会立刻收），
// 留出「看清哪个数字是哪个 pane」的时间，同时不会长期占着键盘。
export const DISPLAY_PANES_TIMEOUT_MS = 4000
// 触发键选 Alt+p：全局 Alt 组合目前只有编辑器里的 Alt+←/→，Alt+p 未被占；
// 单字母 g 会和终端输入冲突（终端是常态焦点），Ctrl+Shift+P 与 VSCode 风格重叠且易撞。
export const DISPLAY_PANES_TRIGGER = { key: 'p', alt: true }

export interface DisplayPanesState {
  active: boolean
  mode: DisplayPanesMode
  targets: NumberTarget[]
}

const IDLE: DisplayPanesState = { active: false, mode: 'panes', targets: [] }

export interface UseDisplayPanesOptions {
  enabled: boolean
  panes: Pane[]
  windows: Window[]
  /** zoom 态只有单 pane 铺满，pane 几何不可见 → 退化成 window 级编号 */
  zoomed: boolean
  onPickPane: (paneId: string) => void
  onPickWindow: (windowId: string) => void
}

export function useDisplayPanes({ enabled, panes, windows, zoomed, onPickPane, onPickWindow }: UseDisplayPanesOptions) {
  const [state, setState] = useState<DisplayPanesState>(IDLE)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const layerRef = useRef<number | null>(null)
  const focusRef = useRef<HTMLElement | null>(null)
  // 键盘监听里要读到最新 targets，用 ref 避免每次重装监听
  const stateRef = useRef<DisplayPanesState>(IDLE)
  const pickRef = useRef({ onPickPane, onPickWindow })
  pickRef.current = { onPickPane, onPickWindow }

  const close = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (layerRef.current !== null) {
      popKeyLayer(layerRef.current)
      layerRef.current = null
    }
    stateRef.current = IDLE
    setState(IDLE)
    // 编号层不抢焦点：开层时没动焦点，关层只把焦点还原回终端（若期间被别处拿走则不动）
    const previous = focusRef.current
    focusRef.current = null
    if (previous && typeof previous.focus === 'function' && !previous.isConnected) previous.focus()
  }, [])

  const open = useCallback(() => {
    if (!enabled) return
    const paneTargets = zoomed ? [] : buildPaneTargets(panes)
    const mode: DisplayPanesMode = paneTargets.length ? 'panes' : 'windows'
    const targets = paneTargets.length ? paneTargets : buildWindowTargets(windows)
    // 没得跳就别闪一层空壳
    if (!targets.length) return
    focusRef.current = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null
    const next = { active: true, mode, targets }
    stateRef.current = next
    setState(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(close, DISPLAY_PANES_TIMEOUT_MS)
    // Esc 走全局层栈，和其它浮层保持一致的取消语义
    if (layerRef.current === null) layerRef.current = pushKeyLayer({ onEscape: close })
  }, [close, enabled, panes, windows, zoomed])

  const toggle = useCallback(() => {
    if (stateRef.current.active) close()
    else open()
  }, [close, open])

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!stateRef.current.active) {
        if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === DISPLAY_PANES_TRIGGER.key) {
          event.preventDefault()
          event.stopPropagation()
          open()
        }
        return
      }
      // 层开着：所有按键都归这一层，绝不能让数字漏进终端
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        close()
        return
      }
      const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : NaN
      const target = Number.isNaN(digit) ? undefined : stateRef.current.targets.find((t) => t.number === digit)
      if (!target) {
        // 任意其它键 = 取消（tmux 里错键也是退出），比死等超时更跟手
        close()
        return
      }
      if (stateRef.current.mode === 'panes') pickRef.current.onPickPane(target.id)
      else pickRef.current.onPickWindow(target.id)
      close()
    }
    const onPointerDown = () => {
      if (stateRef.current.active) close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [close, enabled, open])

  // 组件卸载时清干净，避免定时器和层栈残留
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (layerRef.current !== null) popKeyLayer(layerRef.current)
      layerRef.current = null
    },
    [],
  )

  return { ...state, toggle, close }
}
