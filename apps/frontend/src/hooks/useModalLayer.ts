'use client'

import { useEffect, useRef } from 'react'
import { popKeyLayer, pushKeyLayer } from '@/lib/modal-layers'

interface UseModalLayerOptions {
  open: boolean
  /** 弹窗根元素：判定按键目标是否在弹窗内 */
  getEl: () => HTMLElement | null
  /** Esc 关闭；忙时不想被关就传带条件判断的函数（不要靠 open 关停——关停期间 Esc 会穿透到背景） */
  onEscape?: () => void
  /** Enter 主操作：弹窗内非控件区域、或焦点在弹窗外时触发 */
  onEnter?: () => void
}

// 模态弹窗注册进全局按键层叠栈（modal-layers.ts）。
// 不带 ModalPortal 的自定义结构用本 hook + 在根元素挂 ref 即可
export function useModalLayer({ open, getEl, onEscape, onEnter }: UseModalLayerOptions) {
  const optsRef = useRef({ getEl, onEscape, onEnter })
  optsRef.current = { getEl, onEscape, onEnter }

  useEffect(() => {
    if (!open) return
    const id = pushKeyLayer({
      getEl: () => optsRef.current.getEl(),
      onEscape: () => optsRef.current.onEscape?.(),
      onEnter: () => optsRef.current.onEnter?.(),
    })
    return () => popKeyLayer(id)
  }, [open])
}
