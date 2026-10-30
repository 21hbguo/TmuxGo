'use client'
import { useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MARKDOWN_PROSE_CLASS } from '@/lib/markdown'

export interface MarkdownPreviewLabels {
  imageFailed: string
  imageUnavailable: string
  copyCode: string
  copied: string
}
export interface MarkdownPreviewProps {
  html: string
  loadImage?: (src: string) => Promise<string | null>
  onJump?: (line: number) => void
  onOpenExternal?: (href: string) => void
  onCopyCode?: (code: string) => Promise<void> | void
  labels: MarkdownPreviewLabels
  className?: string
  testId?: string
}

const COPIED_RESET_MS = 1200
const COPY_LABEL = '🔗'

// 占位卡替换 <img>：不允许出现浏览器裂图图标（那是「地址错」的误导信号），
// 而应该明确说清是「加载失败」还是「这种路径不支持」
function createImageFallback(img: HTMLImageElement, message: string) {
  const alt = (img.getAttribute('alt') || '').trim()
  const wrapper = document.createElement('span')
  wrapper.setAttribute('data-md-image-fallback', img.dataset.mdState === 'unsupported' ? 'unsupported' : 'failed')
  wrapper.className =
    'my-3 inline-flex max-w-full flex-wrap items-baseline gap-x-2 rounded-apple border border-dashed border-[var(--line)] bg-bg-2/40 px-3 py-2 text-xs text-text-3'
  if (alt) {
    const name = document.createElement('span')
    name.className = 'font-medium text-text-2 break-all'
    name.textContent = alt
    wrapper.append(name)
  }
  const hint = document.createElement('span')
  hint.textContent = message
  wrapper.append(hint)
  wrapper.setAttribute('role', 'img')
  wrapper.setAttribute('aria-label', alt ? `${alt}: ${message}` : message)
  return wrapper
}

export function MarkdownPreview({
  html,
  loadImage,
  onJump,
  onOpenExternal,
  onCopyCode,
  labels,
  className,
  testId = 'markdown-preview',
}: MarkdownPreviewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const timersRef = useRef<number[]>([])

  // 图片：本地图交给 loadImage 换成 blob URL；unsupported/失败一律换成占位卡。
  // 每次 html 变化（React 重设 innerHTML）都要重扫一遍，异步回来后先确认节点还在文档里再改
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let cancelled = false
    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-md-src]'))
    for (const img of images) {
      if (img.dataset.mdLoaded === '1' || !img.isConnected) continue
      const src = img.dataset.mdSrc || ''
      if (img.dataset.mdState === 'unsupported') {
        img.replaceWith(createImageFallback(img, labels.imageUnavailable))
        continue
      }
      if (img.dataset.mdKind === 'external' || img.dataset.mdKind === 'data') continue
      if (!loadImage) {
        img.replaceWith(createImageFallback(img, labels.imageUnavailable))
        continue
      }
      void loadImage(src).then((url) => {
        if (cancelled || !img.isConnected) return
        if (!url) {
          img.replaceWith(createImageFallback(img, labels.imageFailed))
          return
        }
        img.src = url
        img.dataset.mdLoaded = '1'
      })
    }
    return () => {
      cancelled = true
    }
  }, [html, loadImage, labels])

  // 代码块复制按钮：每次 html 变化重建；innerHTML 整体替换后旧按钮自然消失，这里的去重只是防重复 append
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      if (pre.querySelector(':scope > button[data-md-copy]')) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-md-copy', '1')
      button.setAttribute('aria-label', labels.copyCode)
      button.title = labels.copyCode
      button.textContent = COPY_LABEL
      button.className =
        'absolute top-1.5 right-1.5 rounded bg-bg-1/80 px-1.5 py-0.5 text-[11px] leading-4 text-text-3 opacity-60 transition-opacity hover:text-text-1 hover:opacity-100 focus-visible:opacity-100'
      pre.append(button)
    }
  }, [html, labels])

  // 卸载时清掉「已复制」回退定时器，避免在已销毁的 DOM 上写 textContent
  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer)
      timersRef.current = []
    },
    [],
  )

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onJump) return
    const target = (event.target as HTMLElement).closest('[data-line]')
    if (!target) return
    const line = Number(target.getAttribute('data-line'))
    if (!line) return
    event.preventDefault()
    onJump(line)
  }

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement
    const copy = element.closest('button[data-md-copy]')
    if (copy) {
      const pre = copy.closest('pre')
      const code = pre?.querySelector('code')
      const text = code?.textContent ?? ''
      event.preventDefault()
      event.stopPropagation()
      if (onCopyCode) void Promise.resolve(onCopyCode(text)).catch(() => {})
      // clipboard 在非安全上下文/jsdom 里可能不存在，别在 undefined 上链式调用
      else void navigator.clipboard?.writeText(text)?.catch(() => {})
      copy.textContent = labels.copied
      const timer = window.setTimeout(() => {
        if (copy.isConnected) copy.textContent = COPY_LABEL
      }, COPIED_RESET_MS)
      timersRef.current.push(timer)
      return
    }
    const link = element.closest('a[data-md-external]')
    if (link && onOpenExternal) {
      // 拦截默认导航：SPA 整页跳走会丢编辑态/未保存内容
      event.preventDefault()
      onOpenExternal(link.getAttribute('href') || '')
    }
  }

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      className={className || MARKDOWN_PROSE_CLASS}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
