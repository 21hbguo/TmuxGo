'use client'

import { useEffect, useRef } from 'react'
import { isImeKeyEvent } from '@/lib/terminal-platform'

// 全局 Escape 层叠栈：嵌套弹窗/菜单共存时只放行最上层的 onClose，
// 避免一次按键把底下几层一起关掉
const escapeStack: number[] = []
let nextEscapeId = 1

export function useEscapeClose(onClose: (() => void) | undefined, enabled = true) {
  const idRef = useRef(0)
  if (!idRef.current) idRef.current = nextEscapeId++
  // onClose 走 ref：内联回调每次渲染都变，不能让它进依赖逼 effect 反复出栈/入栈（会错序顶到最上层）
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!enabled || !onCloseRef.current) return
    const id = idRef.current
    escapeStack.push(id)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyEvent(event)) return
      if (escapeStack[escapeStack.length - 1] !== id) return
      // capture 阶段拦停：焦点在下层元素/终端里时按键也不会穿透到它们
      event.stopPropagation()
      onCloseRef.current?.()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      const index = escapeStack.indexOf(id)
      if (index !== -1) escapeStack.splice(index, 1)
    }
  }, [enabled])
}
