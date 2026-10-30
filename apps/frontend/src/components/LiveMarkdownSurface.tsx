'use client'
import { useCallback, useEffect, useMemo } from 'react'
import { CmMarkdownEditor, type CmMarkdownApi } from './CmMarkdownEditor'
import { createMarkdownImageLoader } from '@/lib/markdown-image-cache'
import { clearMarkdownImageCache } from '@/lib/cm6/decorations'

export interface LiveMarkdownSurfaceProps {
  content: string
  path: string
  hostId: string
  rootId: string
  theme: 'dark' | 'light'
  fontFamily: string
  fontSize: number
  wordWrap: boolean
  revealLine: { line: number; nonce: number } | null
  onChange: (next: string) => void
  onSave: () => void
  onCursorChange: (info: { line: number; column: number; selectedChars: number }) => void
  onReady: (api: CmMarkdownApi | null) => void
  ariaLabel: string
}

// CM6 是重模块：这个壳由 EditorWorkbench 用 dynamic() 懒加载，只有 markdown live 模式才拉 chunk。
// 图片 loader 与预览组件共用同一套 blob 缓存语义（并发 3、切文件 dispose、revoke）。
export function LiveMarkdownSurface({
  content,
  path,
  hostId,
  rootId,
  theme,
  fontFamily,
  fontSize,
  wordWrap,
  revealLine,
  onChange,
  onSave,
  onCursorChange,
  onReady,
  ariaLabel,
}: LiveMarkdownSurfaceProps) {
  const loader = useMemo(() => createMarkdownImageLoader({ hostId, rootId, filePath: path }), [hostId, rootId, path])
  useEffect(
    () => () => {
      loader.dispose()
      // 装饰层的图片缓存保存的是 blob URL，loader 一 revoke 就必须一起失效，否则切回来是死链
      clearMarkdownImageCache()
    },
    [loader],
  )
  const loadImage = useCallback(
    (_src: string, resolvedPath: string | null) =>
      resolvedPath ? loader.loadResolved(resolvedPath) : Promise.resolve(null),
    [loader],
  )
  const openExternal = useCallback((href: string) => window.open(href, '_blank', 'noopener,noreferrer'), [])
  return (
    <CmMarkdownEditor
      value={content}
      documentPath={path}
      onChange={onChange}
      onSave={onSave}
      onCursorChange={onCursorChange}
      onReady={onReady}
      loadImage={loadImage}
      onOpenExternal={openExternal}
      theme={theme}
      fontFamily={fontFamily}
      fontSize={fontSize}
      wordWrap={wordWrap}
      revealLine={revealLine}
      ariaLabel={ariaLabel}
      autoFocus
    />
  )
}
