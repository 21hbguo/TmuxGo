'use client'

import { useEffect, useState } from 'react'
import { Button } from './Button'

export interface PdfPreviewLabels {
  loading: string
  failed: string
  openNew: string
  download: string
  large: string
}

export interface PdfPreviewProps {
  name: string
  url: string
  size?: number
  labels: PdfPreviewLabels
  /** 超过这个体积先不挂 iframe：浏览器 PDF 插件会整份拉流，大文件容易把内存打满 */
  maxInlineBytes?: number
}

const DEFAULT_MAX_INLINE_BYTES = 64 * 1024 * 1024
const LOAD_TIMEOUT_MS = 8000

export function PdfPreview({ name, url, size, labels, maxInlineBytes = DEFAULT_MAX_INLINE_BYTES }: PdfPreviewProps) {
  const oversized = typeof size === 'number' && size > maxInlineBytes
  const [gateOpen, setGateOpen] = useState(!oversized)
  const [loaded, setLoaded] = useState(false)
  const [timedOut, setTimedOut] = useState(false)

  // 换 URL 等于换文档：加载态与超时都要重置，否则上一份的兜底条会留在新文件上
  useEffect(() => {
    setLoaded(false)
    setTimedOut(false)
  }, [url])

  useEffect(() => {
    if (!gateOpen || loaded) return
    const timer = window.setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [gateOpen, loaded, url])

  if (!gateOpen)
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-apple bg-bg-1 p-6 text-center">
        <p className="max-w-full truncate text-sm text-text-1" title={name}>
          {name}
        </p>
        <Button data-testid="pdf-gate" onClick={() => setGateOpen(true)}>
          {labels.large}
        </Button>
      </div>
    )

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-1">
      <iframe
        data-testid="pdf-frame"
        title={name}
        src={url}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-bg-1"
        onLoad={() => setLoaded(true)}
      />
      {!loaded && !timedOut ? (
        <div
          data-testid="pdf-loading"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-text-2"
        >
          {labels.loading}
        </div>
      ) : null}
      {timedOut ? (
        <div
          data-testid="pdf-fallback"
          className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-3 border-t border-[var(--line)] bg-bg-2 px-3 py-2 text-xs text-text-2"
        >
          <span className="min-w-0 flex-1 truncate">{labels.failed}</span>
          <a href={url} target="_blank" rel="noreferrer" className="underline">
            {labels.openNew}
          </a>
          <a href={url} download={name} className="underline">
            {labels.download}
          </a>
        </div>
      ) : null}
    </div>
  )
}
