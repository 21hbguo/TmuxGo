'use client'
import { useCallback, useEffect, useMemo } from 'react'
import { MarkdownPreview } from './MarkdownPreview'
import { createMarkdownImageLoader } from '@/lib/markdown-image-cache'

export interface MarkdownPreviewHostLabels {
  imageFailed: string
  imageUnavailable: string
  copyCode: string
  copied: string
}
export interface MarkdownPreviewHostProps {
  html: string
  hostId: string
  rootId: string
  filePath: string
  labels: MarkdownPreviewHostLabels
  onJump?: (line: number) => void
  onOpenExternal?: (href: string) => void
}

// 图片 loader 跟着文件走：切文件/卸载即 dispose，否则 objectURL 泄漏。
// MarkdownPreview 只负责渲染，缓存/并发/revoke 在这个壳里收口（编辑区与手机预览共用）。
export function MarkdownPreviewHost({
  html,
  hostId,
  rootId,
  filePath,
  labels,
  onJump,
  onOpenExternal,
}: MarkdownPreviewHostProps) {
  const loader = useMemo(() => createMarkdownImageLoader({ hostId, rootId, filePath }), [hostId, rootId, filePath])
  useEffect(() => () => loader.dispose(), [loader])
  const loadImage = useCallback((src: string) => loader.load(src), [loader])
  const openExternal = useCallback(
    (href: string) => {
      if (onOpenExternal) onOpenExternal(href)
      else window.open(href, '_blank', 'noopener,noreferrer')
    },
    [onOpenExternal],
  )
  return (
    <MarkdownPreview html={html} loadImage={loadImage} onJump={onJump} onOpenExternal={openExternal} labels={labels} />
  )
}
