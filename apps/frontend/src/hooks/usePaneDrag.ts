'use client'
import { useSyncExternalStore } from 'react'
import { getPaneDrag, subscribePaneDrag, type PaneDragPayload } from '@/lib/pane-drag'

/**
 * 订阅「当前正在拖的 pane」。服务端渲染时恒为 null（拖拽只发生在浏览器里），
 * 第三个参数给 snapshot 兜底避免 hydration 不一致。
 */
export function usePaneDrag(): PaneDragPayload | null {
  return useSyncExternalStore(subscribePaneDrag, getPaneDrag, () => null)
}
