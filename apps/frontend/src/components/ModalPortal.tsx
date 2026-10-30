'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '@/hooks/useModalLayer'
import { useWorkspaceZoom } from '@/lib/workspace-zoom'

interface ModalPortalProps {
  children: ReactNode
  /** 模态层：登记进全局按键层叠栈——Esc 只归栈顶弹窗；弹窗开着而焦点在外面时
   *  无修饰键一律拦停（防止 Enter/字符穿透写进背后的终端），Enter 转调 onEnter */
  modal?: boolean
  onEscape?: () => void
  onEnter?: () => void
}

export function ModalPortal({ children, modal, onEscape, onEnter }: ModalPortalProps) {
  const [mounted, setMounted] = useState(false)
  const layerRef = useRef<HTMLDivElement>(null)
  // 弹窗挂在 body 上，不在 app-shell 的 zoom 里；单独跟随 UI 缩放，避免“外壳变大、弹窗不变”
  const uiScale = useWorkspaceZoom((state) => state.uiScale)

  useEffect(() => {
    setMounted(true)
  }, [])

  useModalLayer({
    open: !!modal && mounted,
    getEl: () => layerRef.current,
    onEscape,
    onEnter,
  })

  if (!mounted) return null
  // 包一层真实 div 供层叠栈做 contains 判定；子节点都是 fixed 定位，零视觉影响
  return createPortal(
    <div
      ref={layerRef}
      tabIndex={modal ? -1 : undefined}
      className="outline-none"
      style={uiScale === 1 ? undefined : { zoom: uiScale }}
    >
      {children}
    </div>,
    document.body,
  )
}
