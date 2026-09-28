'use client'

import { useEffect, useRef } from 'react'
import { popKeyLayer, pushKeyLayer } from '@/lib/modal-layers'

// 全局 Escape 层叠栈（见 modal-layers.ts）：嵌套弹窗/菜单共存时只有最上层
// 的 onClose 响应，一次按键不会把底下几层一起关掉；栈非空时 Esc 被拦停，
// 不会穿透到下层元素/终端
export function useEscapeClose(onClose: (() => void) | undefined, enabled = true) {
  // onClose 走 ref：内联回调每次渲染都变，不能让它进依赖逼 effect 反复出栈/入栈（会错序顶到最上层）
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!enabled || !onCloseRef.current) return
    const id = pushKeyLayer({ onEscape: () => onCloseRef.current?.() })
    return () => popKeyLayer(id)
  }, [enabled])
}
